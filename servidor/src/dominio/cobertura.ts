// Cobertura agregada: cuántos taxis podrían venir, y dónde se está pidiendo.
//
// Las dos vistas son SIEMPRE por zona y nunca por persona. El razonamiento
// completo está en la migración 023; el resumen es que un punto que se puede
// seguir en un mapa es una herramienta de acoso y de robo, y que enseñarle al
// pasajero un taxi a cien metros le invita a pararlo en la calle, donde la
// plataforma no cobra nada.
//
// LA REGLA IMPORTANTE de este módulo: un taxi contado tiene que ser un taxi
// que de verdad puede recibir la carrera. Contar taxis que el reparto va a
// descartar sería prometer un coche que no va a venir, y eso es peor que
// decir «ahora no hay»: la segunda vez ya nadie te cree.

import type pg from 'pg';
import { leerParametroEntero } from './parametros.js';
import { estimarLlegada } from './llegada.js';

export interface TaxisCerca {
  // Zona del punto de recogida, para poder nombrarla al contestar.
  zona: string;
  zonaId: number;
  // Taxis que podrían aceptar AHORA: en la zona o en una adyacente, que es
  // hasta donde llega el reparto por oleadas.
  disponibles: number;
  // De ellos, cuántos están en la zona misma. Sirve para matizar («2 en tu
  // barrio y 3 al lado») sin dar ninguna posición.
  enTuZona: number;
  // Cuándo se contó. El pasajero tiene derecho a saber si el número es de
  // ahora o de hace un rato; sin esto un conteo viejo es una mentira.
  contadoEn: string;
}

// Los mismos filtros que `hayConductoresVivos()` en despacho.ts, que es la
// función que decide si una solicitud se corta con SIN_OFERTA inmediato (R1).
// Esa —y no `candidatos()`— es la pregunta que el pasajero está haciendo:
// «¿voy a conseguir taxi?», no «¿hay un taxi libre en este microsegundo?».
//
// La diferencia es OFERTADO, e importa. Un taxi con una oferta pendiente no
// es candidato ahora, pero está conectado y puede quedar libre dentro de los
// 90 s de la ventana. Contándolo con `candidatos()` el conteo decía CERO con
// un taxi en la esquina: el pasajero leía «no hay taxi», pedía igual y el
// sistema se ponía a buscar — desmintiéndome delante de él. Salió al probarlo
// contra un taxi de verdad en servicio.
//
// Si estos filtros y los del reparto se separan, el pasajero verá taxis
// fantasma o dejará de ver taxis que existen: cualquier cambio allí hay que
// copiarlo aquí.
//
// A propósito NO se filtra por saldo: `tieneSaldoParaComision` existe (R5)
// pero el reparto no la aplica hoy, y este conteo tiene que parecerse a lo
// que el reparto hace de verdad, no a lo que debería hacer (ver P23-01).
//
// El hueco de la ventana de heartbeat se pasa como parámetro porque cada
// consulta lo tiene en una posición distinta. Iba fijo a $2 y en la consulta
// de demanda $2 era el umbral mínimo (3): habría contado taxis con tres
// segundos de heartbeat, o sea casi ninguno, y el taxista habría visto zonas
// «desiertas» que estaban atendidas.
const filtroTaxiVivo = (huecoVentanaSeg: string): string => `
  p.estado IN ('DISPONIBLE', 'OFERTADO')
  AND p.ultimo_heartbeat IS NOT NULL
  AND p.ultimo_heartbeat >= now() - make_interval(secs => ${huecoVentanaSeg})
  AND c.estado_verificacion = 'verificado'
  AND c.suscrito_hasta IS NOT NULL
  AND c.suscrito_hasta > now()
  AND (SELECT count(*) FROM solicitud sp
       WHERE sp.conductor_id = c.id
         AND sp.estado IN ('ACEPTADO', 'EN_CAMINO', 'RECOGIDO')) < v.plazas`;

// Cuántos taxis podrían venir a por alguien que sale de esta referencia.
// Devuelve null si la referencia no existe: quien pregunta por un sitio que
// no está en el catálogo no merece un cero, que se leería como «no hay taxis».
export async function taxisCercaDe(
  cliente: pg.ClientBase | pg.Pool,
  referenciaId: number,
): Promise<TaxisCerca | null> {
  // COALESCE(zona_padre_id, id): igual que en el reparto (despacho.ts) — si
  // el lugar cuelga de un barrio/calle sin adyacencia propia, se cuenta por
  // su distrito urbano padre. `nombre` se deja el del barrio/calle: es lo
  // preciso que ve el pasajero, aunque el conteo sea por el padre.
  const zona = await cliente.query(
    `SELECT COALESCE(z.zona_padre_id, z.id)::int AS id, z.nombre
     FROM referencia r JOIN zona z ON z.id = r.zona_id
     WHERE r.id = $1`,
    [referenciaId],
  );
  if (zona.rowCount === 0) return null;
  const zonaId: number = zona.rows[0].id;

  const ventanaSeg = await leerParametroEntero(cliente, 'ventana_heartbeat_seg');
  const res = await cliente.query(
    `SELECT
       count(*)::int AS disponibles,
       count(*) FILTER (WHERE p.zona_id = $1)::int AS en_tu_zona
     FROM presencia p
     JOIN conductor c ON c.id = p.conductor_id
     -- JOIN y no LEFT JOIN, igual que en el reparto: sin vehículo no hay
     -- matrícula, y sin matrícula no se despacha.
     JOIN vehiculo v ON v.conductor_id = c.id
     WHERE (p.zona_id = $1 OR p.zona_id IN (
              SELECT zona_adyacente_id FROM zona_adyacencia WHERE zona_id = $1))
       AND ${filtroTaxiVivo('$2')}`,
    [zonaId, ventanaSeg],
  );

  return {
    zona: zona.rows[0].nombre,
    zonaId,
    disponibles: res.rows[0].disponibles,
    enTuZona: res.rows[0].en_tu_zona,
    contadoEn: new Date().toISOString(),
  };
}

export interface ZonaConDemanda {
  zona: string;
  zonaId: number;
  // Solicitudes en la ventana. Nunca cuáles, ni de quién, ni dónde dentro de
  // la zona.
  pedidas: number;
  // De ellas, cuántas se quedaron sin taxi. Es la cifra que le interesa al
  // taxista: ahí hay dinero que nadie recogió.
  sinTaxi: number;
  // Taxis disponibles ahí ahora mismo, para que se vea si la zona ya está
  // atendida o está desierta.
  taxisAhora: number;
}

// Dónde se está pidiendo taxi, por barrio. Para que el taxista conduzca hacia
// el trabajo en vez de dar vueltas quemando combustible.
//
// Se ordena por demanda desatendida: lo primero de la lista es donde se están
// perdiendo carreras. Las zonas por debajo del umbral no se nombran (ver la
// migración 023: con una sola solicitud, nombrar la zona casi señala a la
// persona que la pidió).
export async function demandaPorZona(
  cliente: pg.ClientBase | pg.Pool,
  limite = 5,
): Promise<{ zonas: ZonaConDemanda[]; ventanaMin: number }> {
  const ventanaMin = await leerParametroEntero(cliente, 'demanda_ventana_min');
  const minimo = await leerParametroEntero(cliente, 'demanda_minima_zona');
  const ventanaHeartbeatSeg = await leerParametroEntero(cliente, 'ventana_heartbeat_seg');

  const res = await cliente.query(
    `WITH demanda AS (
       SELECT z.id::int AS zona_id, z.nombre AS zona,
              count(*)::int AS pedidas,
              count(*) FILTER (WHERE s.estado = 'SIN_OFERTA')::int AS sin_taxi
       FROM solicitud s
       JOIN referencia r ON r.id = s.referencia_origen_id
       JOIN zona z ON z.id = r.zona_id
       WHERE s.creada_en >= now() - make_interval(mins => $1)
       GROUP BY z.id, z.nombre
       HAVING count(*) >= $2
     )
     SELECT d.zona_id, d.zona, d.pedidas, d.sin_taxi,
            (SELECT count(*)::int
             FROM presencia p
             JOIN conductor c ON c.id = p.conductor_id
             JOIN vehiculo v ON v.conductor_id = c.id
             WHERE p.zona_id = d.zona_id AND ${filtroTaxiVivo('$4')}) AS taxis_ahora
     FROM demanda d
     ORDER BY d.sin_taxi DESC, d.pedidas DESC, d.zona
     LIMIT $3`,
    [ventanaMin, minimo, limite, ventanaHeartbeatSeg],
  );

  return {
    zonas: res.rows.map((f: {
      zona_id: number; zona: string; pedidas: number; sin_taxi: number; taxis_ahora: number;
    }) => ({
      zona: f.zona,
      zonaId: f.zona_id,
      pedidas: f.pedidas,
      sinTaxi: f.sin_taxi,
      taxisAhora: f.taxis_ahora,
    })),
    ventanaMin,
  };
}

// --- Elegir coche (24/09) ---------------------------------------------------

export interface TaxiElegible {
  // Hace falta para poder pedir ESE coche. No dice nada de la persona: es un
  // número de fila, y el nombre y la matrícula ya se entregan al asignarlo.
  conductorId: number;
  marca: string | null;
  color: string | null;
  carroceria: string | null;
  plazas: number;
  aireAcondicionado: boolean;
  seguro: boolean;
  valoracion: number | null;
  valoraciones: number;
  // Lo que se estima que tardaría en llegar a por esta persona. null si el
  // coche no ha mandado posición reciente: entonces no se sabe, y decir un
  // número inventado sería peor.
  etaMin: number | null;
  distanciaM: number | null;
  // Si va a llegar desde el barrio del pasajero o desde uno vecino. Es la
  // única pista de sitio que se da, y es la que ya daba el conteo.
  enTuZona: boolean;
}

// Los taxis que PODRÍAN venir a por alguien que sale de esta referencia, uno a
// uno, para que el pasajero elija.
//
// Es el mismo conteo de `taxisCercaDe` abierto en filas, con los mismos
// filtros —si aquí apareciera un taxi que el reparto va a descartar, se le
// estaría ofreciendo un coche que no puede venir— más lo que hace falta para
// decidir: qué coche es, cómo lo valoran y cuánto tardaría.
//
// LO QUE NO SE DA, y es deliberado: ninguna posición, ni el nombre, ni el
// teléfono, ni la matrícula. La regla de la migración 023 sigue entera —un
// punto que se puede seguir en un mapa es una herramienta de acoso, y ver un
// taxi a cien metros invita a bajar a pararlo en la calle, donde la plataforma
// no cobra—. Un tiempo estimado no se puede seguir.
export async function taxisElegiblesDe(
  cliente: pg.ClientBase | pg.Pool,
  referenciaId: number,
  limite = 8,
): Promise<TaxiElegible[]> {
  const zona = await cliente.query(
    `SELECT COALESCE(z.zona_padre_id, z.id)::int AS id
     FROM referencia r JOIN zona z ON z.id = r.zona_id
     WHERE r.id = $1`,
    [referenciaId],
  );
  if (zona.rowCount === 0) return [];
  const zonaId: number = zona.rows[0].id;
  const ventanaSeg = await leerParametroEntero(cliente, 'ventana_heartbeat_seg');
  const frescuraSeg = await leerParametroEntero(cliente, 'gps_frescura_seg');

  const res = await cliente.query(
    `SELECT c.id AS conductor_id, v.marca, v.color, v.carroceria, v.plazas,
            v.aire_acondicionado, v.seguro,
            (p.zona_id = $1) AS en_tu_zona,
            -- La misma cuenta que reputacionDe: solo lo que puntuó el
            -- pasajero, nunca lo que el taxista puntuó a sus pasajeros.
            (SELECT round(avg(va.puntuacion)::numeric, 1) FROM valoracion va
             JOIN viaje vi ON vi.id = va.viaje_id
             WHERE vi.conductor_id = c.id AND va.emisor = 'cliente') AS valoracion,
            (SELECT count(*)::int FROM valoracion va
             JOIN viaje vi ON vi.id = va.viaje_id
             WHERE vi.conductor_id = c.id AND va.emisor = 'cliente') AS valoraciones,
            -- Su última posición conocida, SOLO para medir el tiempo. No sale
            -- de esta función.
            (SELECT po.lat FROM posicion po
             JOIN viaje vi ON vi.id = po.viaje_id
             JOIN solicitud so ON so.id = vi.solicitud_id
             WHERE so.conductor_id = c.id AND po.actor = 'conductor'
               AND po.creado_en >= now() - make_interval(secs => $3)
             ORDER BY po.creado_en DESC LIMIT 1) AS lat,
            (SELECT po.lng FROM posicion po
             JOIN viaje vi ON vi.id = po.viaje_id
             JOIN solicitud so ON so.id = vi.solicitud_id
             WHERE so.conductor_id = c.id AND po.actor = 'conductor'
               AND po.creado_en >= now() - make_interval(secs => $3)
             ORDER BY po.creado_en DESC LIMIT 1) AS lng,
            -- Y si no hay ninguna, el centro de su barrio: no es su posición,
            -- es el barrio que él mismo declaró al entrar en servicio, que es
            -- lo que ya se le enseña al pasajero en el conteo.
            z.centroide_lat AS zona_lat, z.centroide_lng AS zona_lng
     FROM presencia p
     JOIN conductor c ON c.id = p.conductor_id
     JOIN vehiculo v ON v.conductor_id = c.id
     LEFT JOIN zona z ON z.id = p.zona_id
     WHERE (p.zona_id = $1 OR p.zona_id IN (
              SELECT zona_adyacente_id FROM zona_adyacencia WHERE zona_id = $1)
            OR c.recibe_en_cualquier_zona)
       AND c.unificado_en IS NULL
       AND ${filtroTaxiVivo('$2')}
     LIMIT $4`,
    [zonaId, ventanaSeg, frescuraSeg, limite],
  );

  const destino = await cliente.query(
    'SELECT lat, lng FROM referencia WHERE id = $1', [referenciaId],
  );
  const recogida = {
    lat: Number(destino.rows[0].lat), lng: Number(destino.rows[0].lng),
  };

  const lista: TaxiElegible[] = [];
  for (const f of res.rows) {
    const desde = f.lat !== null && f.lng !== null
      ? { lat: Number(f.lat), lng: Number(f.lng) }
      : f.zona_lat !== null && f.zona_lng !== null
        ? { lat: Number(f.zona_lat), lng: Number(f.zona_lng) }
        : null;
    const estimacion = desde === null ? null : await estimarLlegada(cliente, desde, recogida);
    lista.push({
      conductorId: Number(f.conductor_id),
      marca: f.marca,
      color: f.color,
      carroceria: f.carroceria,
      plazas: Number(f.plazas),
      aireAcondicionado: f.aire_acondicionado,
      seguro: f.seguro,
      valoracion: f.valoracion === null ? null : Number(f.valoracion),
      valoraciones: Number(f.valoraciones),
      etaMin: estimacion?.minutos ?? null,
      distanciaM: estimacion?.distanciaM ?? null,
      enTuZona: f.en_tu_zona === true,
    });
  }
  // Por tiempo, y los que no se sabe al final: un coche del que no se sabe
  // cuándo llega no puede encabezar una lista que se ordena por eso.
  return lista.sort((a, b) => (a.etaMin ?? 9_999) - (b.etaMin ?? 9_999));
}
