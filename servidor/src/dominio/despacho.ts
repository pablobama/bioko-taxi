// Despacho por oleadas + reclamación atómica (paso 5, secciones 3.5, 8, R1 y R2).
//
// Modelo: el cliente no elige en un mapa. La solicitud se emite a conductores
// conectados en oleadas crecientes y el primero que la reclama se la lleva.
//
//   Oleada 1  t=0    hasta 3 conductores, zona del origen
//   Oleada 2  t=20   hasta 8 conductores acumulados, zona del origen
//   Oleada 3  t=45   hasta 8 conductores de zonas adyacentes
//   Oleada 4  t=60   los que reciben de toda la isla (migración 048)
//   Oleada 5  t=75   TODA la ciudad, y solo si nadie tiene la carrera en la
//                    mano: es la carrera o nada (migración 064)
//   t=90            SIN_OFERTA
//
// Todos los umbrales salen de la tabla parametro. La proximidad se modela a
// nivel de zona (no hay GPS continuo por diseño, sección 2): dentro de una
// zona el orden es prioridad_despacho y menor tasa de cancelación.
//
// El reloj (parámetro «ahora») se inyecta siempre: las pruebas simulan el
// paso del tiempo sin esperar.

import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { enTransaccion } from '../bd/conexion.js';
import { ErrorEntidadInexistente, ErrorOfertaInvalida } from './errores.js';
import type { EmisorEventos } from './eventos.js';
import { estadoPorOcupacion, ocupacionDe } from './ocupacion.js';
import { leerParametroEntero } from './parametros.js';
import { caducarPresencias } from './presencia.js';
import { registrarTransicion, transicionarConductor, transicionarSolicitud } from './transiciones.js';

interface SolicitudDespacho {
  id: number;
  estado: string;
  dispositivoClienteId: number;
  // A quién eligió el pasajero al pedir, si eligió a alguien (migración 062).
  conductorElegidoId: number | null;
  zonaOrigenId: number;
  zonaDestinoId: number;
  origenNombre: string;
  destinoNombre: string;
  expiraEn: Date | null;
}

// Lee y BLOQUEA la solicitud (FOR UPDATE). Todo el despacho serializa sobre
// esta fila: oleadas, reclamaciones y expiración no pueden pisarse.
async function bloquearSolicitud(
  cliente: pg.ClientBase,
  solicitudId: number,
): Promise<SolicitudDespacho> {
  const res = await cliente.query(
    // COALESCE(zona_padre_id, id): si el lugar cuelga de un barrio/calle
    // (migración 031, sin adyacencia propia), el reparto usa su distrito
    // urbano padre — la unidad de siempre. Un lugar en «Barrio Bisinga» no
    // se queda sin taxis solo porque el barrio en sí no tiene vecinas.
    `SELECT s.id, s.estado, s.dispositivo_cliente_id, s.expira_en,
            s.conductor_elegido_id,
            COALESCE(zo.zona_padre_id, zo.id) AS zona_origen_id, ro.nombre AS origen_nombre,
            COALESCE(zd.zona_padre_id, zd.id) AS zona_destino_id, rd.nombre AS destino_nombre
     FROM solicitud s
     JOIN referencia ro ON ro.id = s.referencia_origen_id
     JOIN referencia rd ON rd.id = s.referencia_destino_id
     JOIN zona zo ON zo.id = ro.zona_id
     JOIN zona zd ON zd.id = rd.zona_id
     WHERE s.id = $1
     FOR UPDATE OF s`,
    [solicitudId],
  );
  if (res.rowCount === 0) {
    throw new ErrorEntidadInexistente('la solicitud', solicitudId);
  }
  const fila = res.rows[0];
  return {
    id: fila.id,
    estado: fila.estado,
    dispositivoClienteId: fila.dispositivo_cliente_id,
    conductorElegidoId: fila.conductor_elegido_id === null
      ? null : Number(fila.conductor_elegido_id),
    zonaOrigenId: fila.zona_origen_id,
    zonaDestinoId: fila.zona_destino_id,
    origenNombre: fila.origen_nombre,
    destinoNombre: fila.destino_nombre,
    expiraEn: fila.expira_en,
  };
}

// Mueve la presencia solo si hace falta.
//
// Con taxi compartido un conductor puede estar ya DISPONIBLE cuando algo
// intenta «liberarlo»: perdió una reclamación, rechazó una oferta que ya no
// existía, se le expiró una solicitud. Pedir DISPONIBLE → DISPONIBLE es un
// no-op que la máquina de estados rechaza con razón, y ese error acababa en la
// cara del taxista. Quien libera comprueba antes.
async function liberarPresencia(
  cliente: pg.ClientBase,
  conductorId: number,
  actor: 'conductor' | 'sistema',
  origenEvento: string,
): Promise<void> {
  const fila = await cliente.query(
    'SELECT estado FROM presencia WHERE conductor_id = $1 FOR UPDATE',
    [conductorId],
  );
  if (fila.rowCount === 0) return;
  const objetivo = await estadoPorOcupacion(cliente, conductorId);
  if (fila.rows[0].estado !== objetivo) {
    await transicionarConductor(cliente, conductorId, objetivo, actor, origenEvento);
  }
}

async function zonasAdyacentes(cliente: pg.ClientBase, zonaId: number): Promise<number[]> {
  const res = await cliente.query(
    'SELECT zona_adyacente_id FROM zona_adyacencia WHERE zona_id = $1',
    [zonaId],
  );
  return res.rows.map((f) => f.zona_adyacente_id);
}

// Candidatos a recibir la oferta: DISPONIBLE con heartbeat vivo, verificado,
// con suscripción vigente (migración 011: el bloqueo va en la emisión), CON
// PLAZA LIBRE (migración 013: taxi compartido) y sin oferta previa de esta
// solicitud.
//
// Orden, de más a menos importante:
//   1. Va ya hacia allí (algún pasajero a bordo con el mismo destino, o zona
//      de destino coincidente). Es la aproximación barata a «coche que pasa
//      por tu camino», usando zonas: sin cálculo de rutas ni GPS de más.
//   2. prioridad_despacho.
//   3. Menor tasa de cancelación aceptado→cancelado.
async function candidatos(
  cliente: pg.ClientBase,
  solicitudId: number,
  zonaIds: number[],
  limite: number,
  ahora: Date,
  // Oleada 4 (migración 048): ignora el barrio y busca solo entre quienes
  // reciben de toda la isla. Va aparte y no como «zonaIds vacío» para que sea
  // imposible convocar a media flota por un array vacío en otra llamada.
  cualquierZona = false,
  // Oleada 0 (migración 062): el coche que eligió el pasajero, y solo ese.
  // También ignora el barrio —se eligió de una lista que ya incluía los
  // vecinos— pero pasa por TODOS los demás filtros: si no está disponible, o
  // se le acabó la suscripción, o se le llenó el coche entre que el pasajero
  // lo eligió y pulsó, no se le oferta y la carrera sigue su camino normal.
  soloConductorId: number | null = null,
  // Oleada 5 (migración 064): TODOS los taxis en servicio de la ciudad, estén
  // en el barrio que estén y hayan pedido o no recibir de toda la isla. Va
  // aparte de `cualquierZona` porque no es lo mismo: aquello respeta lo que
  // cada taxista eligió, y esto es la llamada de última hora antes de decirle
  // al pasajero que no hay taxi.
  todaLaCiudad = false,
): Promise<number[]> {
  const sinZona = cualquierZona || todaLaCiudad || soloConductorId !== null;
  if ((zonaIds.length === 0 && !sinZona) || limite <= 0) {
    return [];
  }
  const ventanaSeg = await leerParametroEntero(cliente, 'ventana_heartbeat_seg');
  const res = await cliente.query(
    `WITH destino_pedido AS (
       SELECT rd.id AS referencia_id, rd.zona_id
       FROM solicitud s JOIN referencia rd ON rd.id = s.referencia_destino_id
       WHERE s.id = $1
     )
     SELECT p.conductor_id
     FROM presencia p
     JOIN conductor c ON c.id = p.conductor_id
     -- JOIN y no LEFT JOIN a propósito: sin vehículo dado de alta no hay
     -- matrícula (obligatoria, 4.1) ni plazas conocidas, y sin matrícula el
     -- pasajero no puede identificar el coche (R4). No se despacha.
     JOIN vehiculo v ON v.conductor_id = c.id
     CROSS JOIN destino_pedido dp
     WHERE p.estado = 'DISPONIBLE'
       AND ($7::bigint IS NULL OR p.conductor_id = $7)
       AND ($7::bigint IS NOT NULL OR $6 OR $8 OR p.zona_id = ANY($2))
       AND ($7::bigint IS NOT NULL OR $8 OR $6 IS FALSE OR c.recibe_en_cualquier_zona)
       AND p.ultimo_heartbeat IS NOT NULL
       AND p.ultimo_heartbeat >= $3::timestamptz - make_interval(secs => $4)
       AND c.estado_verificacion = 'verificado'
       AND c.suscrito_hasta IS NOT NULL
       AND c.suscrito_hasta > $3
       AND (SELECT count(*) FROM solicitud sp
            WHERE sp.conductor_id = c.id
              AND sp.estado IN ('ACEPTADO', 'EN_CAMINO', 'RECOGIDO')) < v.plazas
       AND NOT EXISTS (SELECT 1 FROM oferta o
                       WHERE o.solicitud_id = $1 AND o.conductor_id = p.conductor_id)
     ORDER BY (SELECT count(*) FROM solicitud sr
               JOIN referencia rr ON rr.id = sr.referencia_destino_id
               WHERE sr.conductor_id = c.id
                 AND sr.estado IN ('ACEPTADO', 'EN_CAMINO', 'RECOGIDO')
                 AND (rr.id = dp.referencia_id OR rr.zona_id = dp.zona_id)) DESC,
              c.prioridad_despacho DESC,
              COALESCE(
                (SELECT count(*)::float FROM transicion t
                 JOIN solicitud s2 ON s2.id = t.solicitud_id
                 WHERE s2.conductor_id = p.conductor_id
                   AND t.estado_nuevo = 'CANCELADO_CONDUCTOR')
                / NULLIF((SELECT count(*) FROM oferta o2
                          WHERE o2.conductor_id = p.conductor_id
                            AND o2.resultado = 'aceptada'), 0),
                0) ASC,
              c.id ASC
     LIMIT $5`,
    [
      solicitudId, zonaIds, ahora, ventanaSeg, limite,
      cualquierZona, soloConductorId, todaLaCiudad,
    ],
  );
  return res.rows.map((f) => f.conductor_id);
}

// Crea las ofertas de una oleada y emite D1 a cada conductor. El broadcast
// lleva destino y banda de precio para decidir antes de aceptar (R2), y
// NUNCA el teléfono del cliente (R3).
async function ofertarA(
  cliente: pg.ClientBase,
  emisor: EmisorEventos,
  solicitud: SolicitudDespacho,
  conductorIds: number[],
  oleada: number,
  ahora: Date,
): Promise<void> {
  if (conductorIds.length === 0) {
    return;
  }
  const banda = await cliente.query(
    `SELECT p25, p50, p75 FROM banda_precio
     WHERE zona_origen_id = $1 AND zona_destino_id = $2`,
    [solicitud.zonaOrigenId, solicitud.zonaDestinoId],
  );
  const bandaPrecio = banda.rowCount === 1
    ? { p25: Number(banda.rows[0].p25), p50: Number(banda.rows[0].p50), p75: Number(banda.rows[0].p75) }
    : null;

  for (const conductorId of conductorIds) {
    await cliente.query(
      `INSERT INTO oferta (solicitud_id, conductor_id, oleada, enviada_en)
       VALUES ($1, $2, $3, $4)`,
      [solicitud.id, conductorId, oleada, ahora],
    );
    await transicionarConductor(cliente, conductorId, 'OFERTADO', 'sistema', `oleada_${oleada}`);
    await emisor.emitir({
      tipo: 'D1_broadcast_solicitud',
      rol: 'conductor',
      solicitudId: solicitud.id,
      conductorId,
      datos: {
        origen: solicitud.origenNombre,
        destino: solicitud.destinoNombre,
        bandaPrecio,
        oleada,
        expiraEn: solicitud.expiraEn,
      },
    }, cliente);
  }
}

// Para el corte de R1 cuenta como vivo también el conductor OFERTADO: está
// conectado y puede quedar libre dentro de la ventana de 90 s. Solo se corta
// si no hay literalmente nadie conectado y cobrable en la zona ni adyacentes…
//
// …ni en toda la isla entre los que reciben de cualquier zona (21/09). Sin esto
// la oleada 4 de la migración 048 no servía para lo único que prometía: «una
// solicitud que iba a morir sin oferta todavía tiene una posibilidad». Si el
// barrio y los vecinos estaban vacíos, este corte cerraba la carrera con «no
// hay taxi» en el acto, y la oleada 4 —que llega a los 60 s— no llegaba a
// existir. Justo el caso de quien opera esto probando desde su oficina, siendo
// el único taxi en servicio.
async function hayConductoresVivos(
  cliente: pg.ClientBase,
  zonaIds: number[],
  ahora: Date,
  // Con el aviso a la ciudad entera encendido (migración 064), el corte mira
  // TODA la ciudad y no solo el barrio y sus vecinos. Si hay un taxi libre en
  // Semu, cerrar la petición a los cero segundos sería dar por perdido justo
  // lo que la oleada 5 viene a salvar.
  todaLaCiudad = false,
): Promise<boolean> {
  if (zonaIds.length === 0 && !todaLaCiudad) {
    return false;
  }
  const ventanaSeg = await leerParametroEntero(cliente, 'ventana_heartbeat_seg');
  const res = await cliente.query(
    `SELECT 1
     FROM presencia p
     JOIN conductor c ON c.id = p.conductor_id
     JOIN vehiculo v ON v.conductor_id = c.id
     WHERE p.estado IN ('DISPONIBLE', 'OFERTADO')
       AND ($4 OR p.zona_id = ANY($1) OR c.recibe_en_cualquier_zona)
       AND p.ultimo_heartbeat IS NOT NULL
       AND p.ultimo_heartbeat >= $2::timestamptz - make_interval(secs => $3)
       AND c.estado_verificacion = 'verificado'
       AND c.suscrito_hasta IS NOT NULL
       AND c.suscrito_hasta > $2
       AND (SELECT count(*) FROM solicitud sp
            WHERE sp.conductor_id = c.id
              AND sp.estado IN ('ACEPTADO', 'EN_CAMINO', 'RECOGIDO')) < v.plazas
     LIMIT 1`,
    [zonaIds, ahora, ventanaSeg, todaLaCiudad],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface ResultadoDespacho {
  resultado: 'EMITIDO' | 'SIN_OFERTA';
  ofertas: number;
}

// Arranca el despacho de una solicitud SOLICITADO. Regla R1: si no hay ni un
// conductor vivo en la zona del origen ni en las adyacentes, corta de
// inmediato con SIN_OFERTA; el cliente jamás espera 90 s en vano.
export async function iniciarDespacho(
  pool: pg.Pool,
  emisor: EmisorEventos,
  solicitudId: number,
  ahora: Date = new Date(),
): Promise<ResultadoDespacho> {
  return enTransaccion(pool, async (cliente) => {
    const solicitud = await bloquearSolicitud(cliente, solicitudId);
    if (solicitud.estado !== 'SOLICITADO') {
      throw new Error(
        `No se puede iniciar el despacho de la solicitud ${solicitudId}: `
        + `está en ${solicitud.estado}, no en SOLICITADO.`,
      );
    }

    const adyacentes = await zonasAdyacentes(cliente, solicitud.zonaOrigenId);
    const todasLasZonas = [solicitud.zonaOrigenId, ...adyacentes];
    // El coche elegido cuenta como vivo aunque no esté en el barrio: se eligió
    // de una lista que incluía los vecinos y los de toda la isla, y cortar la
    // carrera con «no hay taxi» justo después de elegirlo sería absurdo.
    const elegidoVivo = solicitud.conductorElegidoId === null
      ? []
      : await candidatos(cliente, solicitudId, [], 1, ahora, false, solicitud.conductorElegidoId);
    const avisoCiudad = (await leerParametroEntero(cliente, 'aviso_ciudad_entera')) === 1;
    const hayVivos = await hayConductoresVivos(cliente, todasLasZonas, ahora, avisoCiudad);
    if (elegidoVivo.length === 0 && !hayVivos) {
      await transicionarSolicitud(cliente, solicitudId, 'SIN_OFERTA', 'sistema', 'zona_vacia');
      await emisor.emitir({
        tipo: 'C3_sin_conductor',
        rol: 'cliente',
        solicitudId,
        dispositivoClienteId: solicitud.dispositivoClienteId,
        datos: { motivo: 'zona_vacia' },
      }, cliente);
      return { resultado: 'SIN_OFERTA' as const, ofertas: 0 };
    }

    const expiracionSeg = await leerParametroEntero(cliente, 'expiracion_solicitud_seg');
    const expiraEn = new Date(ahora.getTime() + expiracionSeg * 1000);
    await cliente.query('UPDATE solicitud SET expira_en = $2 WHERE id = $1', [solicitudId, expiraEn]);
    solicitud.expiraEn = expiraEn;

    await transicionarSolicitud(cliente, solicitudId, 'EMITIDO', 'sistema', 'primera_oleada');

    // Oleada 0 (migración 062): si el pasajero eligió coche y ese coche puede
    // recibirla, va a él SOLO. Las oleadas normales esperan su turno en
    // `avanzarDespachos`.
    if (elegidoVivo.length > 0) {
      await ofertarA(cliente, emisor, solicitud, elegidoVivo, 0, ahora);
      return { resultado: 'EMITIDO' as const, ofertas: elegidoVivo.length };
    }

    const maximoOleada1 = await leerParametroEntero(cliente, 'oleada_1_max_conductores');
    const oleada1 = await candidatos(cliente, solicitudId, [solicitud.zonaOrigenId], maximoOleada1, ahora);
    await ofertarA(cliente, emisor, solicitud, oleada1, 1, ahora);
    return { resultado: 'EMITIDO' as const, ofertas: oleada1.length };
  });
}

async function segundosDesdeEmision(
  cliente: pg.ClientBase,
  solicitudId: number,
  ahora: Date,
): Promise<number> {
  const res = await cliente.query(
    `SELECT max(creado_en) AS emitido_en FROM transicion
     WHERE solicitud_id = $1 AND estado_nuevo = 'EMITIDO'`,
    [solicitudId],
  );
  return (ahora.getTime() - new Date(res.rows[0].emitido_en).getTime()) / 1000;
}

// Cierra la solicitud por expiración: ofertas pendientes a «expirada»,
// conductores liberados, SIN_OFERTA y aviso al cliente.
async function expirarSolicitud(
  cliente: pg.ClientBase,
  emisor: EmisorEventos,
  solicitud: SolicitudDespacho,
): Promise<void> {
  const pendientes = await cliente.query(
    `UPDATE oferta SET resultado = 'expirada'
     WHERE solicitud_id = $1 AND resultado IS NULL
     RETURNING conductor_id`,
    [solicitud.id],
  );
  for (const fila of pendientes.rows) {
    await liberarPresencia(cliente, fila.conductor_id, 'sistema', 'oferta_expirada');
  }
  await transicionarSolicitud(cliente, solicitud.id, 'SIN_OFERTA', 'sistema', 'oleadas_agotadas');
  await emisor.emitir({
    tipo: 'C3_sin_conductor',
    rol: 'cliente',
    solicitudId: solicitud.id,
    dispositivoClienteId: solicitud.dispositivoClienteId,
    datos: { motivo: 'oleadas_agotadas' },
  }, cliente);
}

// Tique periódico del planificador: avanza oleadas y expira lo vencido.
// Idempotente: puede ejecutarse tantas veces como se quiera.
export async function avanzarDespachos(
  pool: pg.Pool,
  emisor: EmisorEventos,
  ahora: Date = new Date(),
): Promise<void> {
  const activas = await pool.query(`SELECT id FROM solicitud WHERE estado = 'EMITIDO' ORDER BY id`);
  for (const fila of activas.rows) {
    await enTransaccion(pool, async (cliente) => {
      const solicitud = await bloquearSolicitud(cliente, fila.id);
      if (solicitud.estado !== 'EMITIDO') {
        return; // alguien la reclamó o canceló entre la lista y el bloqueo
      }
      const transcurrido = await segundosDesdeEmision(cliente, solicitud.id, ahora);
      const expiracionSeg = await leerParametroEntero(cliente, 'expiracion_solicitud_seg');
      if (transcurrido >= expiracionSeg) {
        await expirarSolicitud(cliente, emisor, solicitud);
        return;
      }

      // La exclusiva del coche elegido (migración 062): mientras dura, no se
      // ofrece a nadie más. Pasada, el reparto normal arranca como si nada, y
      // el elegido se queda con su oferta: puede aceptarla hasta que caduque.
      const elegidoSeg = await leerParametroEntero(cliente, 'oleada_elegido_seg');
      const ofertaElegido = await cliente.query(
        'SELECT 1 FROM oferta WHERE solicitud_id = $1 AND oleada = 0 LIMIT 1',
        [solicitud.id],
      );
      if ((ofertaElegido.rowCount ?? 0) > 0 && transcurrido < elegidoSeg) return;

      const porOleada = await cliente.query(
        `SELECT oleada, count(*)::int AS n FROM oferta WHERE solicitud_id = $1 GROUP BY oleada`,
        [solicitud.id],
      );
      const cuenta = new Map<number, number>(porOleada.rows.map((f) => [Number(f.oleada), f.n]));
      const enOrigen = (cuenta.get(1) ?? 0) + (cuenta.get(2) ?? 0);
      const enAdyacentes = cuenta.get(3) ?? 0;
      const enCualquierZona = cuenta.get(4) ?? 0;

      const oleada2Seg = await leerParametroEntero(cliente, 'oleada_2_seg');
      const oleada3Seg = await leerParametroEntero(cliente, 'oleada_3_seg');
      const maximoOleada1 = await leerParametroEntero(cliente, 'oleada_1_max_conductores');
      const maximoOrigen = await leerParametroEntero(cliente, 'oleada_2_max_conductores');
      const maximoAdyacentes = await leerParametroEntero(cliente, 'oleada_3_max_conductores');

      // Oleada 1 (también cubre la re-emisión por reasignación de R3).
      if (enOrigen < maximoOleada1) {
        const nuevos = await candidatos(
          cliente, solicitud.id, [solicitud.zonaOrigenId], maximoOleada1 - enOrigen, ahora,
        );
        await ofertarA(cliente, emisor, solicitud, nuevos, 1, ahora);
      }
      if (transcurrido >= oleada2Seg && enOrigen < maximoOrigen) {
        const nuevos = await candidatos(
          cliente, solicitud.id, [solicitud.zonaOrigenId], maximoOrigen - enOrigen, ahora,
        );
        await ofertarA(cliente, emisor, solicitud, nuevos, 2, ahora);
      }
      if (transcurrido >= oleada3Seg && enAdyacentes < maximoAdyacentes) {
        const adyacentes = await zonasAdyacentes(cliente, solicitud.zonaOrigenId);
        const nuevos = await candidatos(
          cliente, solicitud.id, adyacentes, maximoAdyacentes - enAdyacentes, ahora,
        );
        await ofertarA(cliente, emisor, solicitud, nuevos, 3, ahora);
      }

      // Oleada 4 (migración 048): los que reciben de toda la isla. Va la
      // última a propósito — cuando ya han tenido su turno los que están en el
      // barrio y en los vecinos— para no quitarle la carrera a nadie que esté
      // de verdad al lado del pasajero. A cambio, una solicitud que iba a
      // morir sin oferta todavía tiene una posibilidad.
      const oleada4Seg = await leerParametroEntero(cliente, 'oleada_4_seg');
      const maximoCualquierZona = await leerParametroEntero(cliente, 'oleada_4_max_conductores');
      if (transcurrido >= oleada4Seg && enCualquierZona < maximoCualquierZona) {
        const nuevos = await candidatos(
          cliente, solicitud.id, [], maximoCualquierZona - enCualquierZona, ahora, true,
        );
        await ofertarA(cliente, emisor, solicitud, nuevos, 4, ahora);
      }

      // Oleada 5 (migración 064): toda la ciudad, y solo antes de rendirse.
      //
      // Las dos condiciones son el diseño entero. La del tiempo es obvia; la
      // otra es la que hace que esto no sea «avisar a todos»: si alguien tiene
      // la oferta delante y todavía no ha contestado, no se convoca a nadie
      // más. Su respuesta puede llegar, y quitarle la carrera al que está al
      // lado del pasajero para dársela al que pulse antes desde el otro
      // extremo de Malabo es exactamente lo que el reparto por oleadas evita.
      if (await avisarACiudadEntera(cliente, emisor, solicitud, transcurrido, ahora)) return;
    });
  }
}

// Devuelve si llegó a convocar a alguien, que es lo que hace las pruebas
// legibles. Fuera de `avanzarDespachos` para que el tique se lea de un vistazo.
async function avisarACiudadEntera(
  cliente: pg.ClientBase,
  emisor: EmisorEventos,
  solicitud: SolicitudDespacho,
  transcurrido: number,
  ahora: Date,
): Promise<boolean> {
  if ((await leerParametroEntero(cliente, 'aviso_ciudad_entera')) !== 1) return false;
  if (transcurrido < await leerParametroEntero(cliente, 'oleada_5_seg')) return false;

  // «Viva» es una oferta sin respuesta todavía. Una rechazada o expirada no
  // cuenta: nadie la tiene en la mano.
  const viva = await cliente.query(
    'SELECT 1 FROM oferta WHERE solicitud_id = $1 AND resultado IS NULL LIMIT 1',
    [solicitud.id],
  );
  if ((viva.rowCount ?? 0) > 0) return false;

  const tope = await leerParametroEntero(cliente, 'oleada_5_max_conductores');
  const nuevos = await candidatos(
    cliente, solicitud.id, [], tope, ahora, false, null, true,
  );
  await ofertarA(cliente, emisor, solicitud, nuevos, 5, ahora);
  return nuevos.length > 0;
}

export interface ResultadoReclamacion {
  gano: boolean;
  motivo?: 'reclamacion_perdida';
  viajeId?: number;
}

// Reclamación atómica (R2). El primero que ejecuta con éxito
//   UPDATE solicitud SET estado='ACEPTADO', conductor_id=$1
//   WHERE id=$2 AND estado='EMITIDO'
// se lleva el viaje. El perdedor recibe el aviso D2 en la misma transacción
// del ganador, no al abrir la app.
export async function reclamarSolicitud(
  pool: pg.Pool,
  emisor: EmisorEventos,
  solicitudId: number,
  conductorId: number,
  ahora: Date = new Date(),
): Promise<ResultadoReclamacion> {
  // Los rechazos con efectos (la expiración fuera de ventana) se devuelven
  // como valor para que la transacción CONFIRME esos efectos, y el error se
  // lanza después. Un throw dentro desharía la propia expiración.
  const resultado = await enTransaccion<ResultadoReclamacion | { rechazo: string }>(pool, async (cliente) => {
    const solicitud = await bloquearSolicitud(cliente, solicitudId);

    const oferta = await cliente.query(
      'SELECT resultado FROM oferta WHERE solicitud_id = $1 AND conductor_id = $2',
      [solicitudId, conductorId],
    );
    if (oferta.rowCount === 0) {
      throw new ErrorOfertaInvalida(
        `El conductor ${conductorId} no tiene ninguna oferta de la solicitud ${solicitudId}.`,
      );
    }

    // Aceptación fuera de ventana (R2): se expira de verdad (se confirma) y
    // se rechaza con los segundos exactos.
    if (solicitud.estado === 'EMITIDO' && solicitud.expiraEn !== null && ahora > solicitud.expiraEn) {
      await expirarSolicitud(cliente, emisor, solicitud);
      const segundos = Math.floor((ahora.getTime() - solicitud.expiraEn.getTime()) / 1000);
      return {
        rechazo: `La solicitud ${solicitudId} ya no está disponible: expiró hace ${segundos} segundos.`,
      };
    }
    if (solicitud.estado === 'SIN_OFERTA' || solicitud.estado === 'CANCELADO_CLIENTE') {
      const terminal = await cliente.query(
        `SELECT max(creado_en) AS momento FROM transicion
         WHERE solicitud_id = $1 AND estado_nuevo = $2`,
        [solicitudId, solicitud.estado],
      );
      const segundos = Math.floor((ahora.getTime() - new Date(terminal.rows[0].momento).getTime()) / 1000);
      const motivo = solicitud.estado === 'SIN_OFERTA'
        ? `expiró hace ${segundos} segundos`
        : `el cliente la canceló hace ${segundos} segundos`;
      return { rechazo: `La solicitud ${solicitudId} ya no está disponible: ${motivo}.` };
    }

    // La reclamación atómica literal de R2.
    const reclamacion = await cliente.query(
      `UPDATE solicitud SET estado = 'ACEPTADO', conductor_id = $1
       WHERE id = $2 AND estado = 'EMITIDO'`,
      [conductorId, solicitudId],
    );
    if (reclamacion.rowCount === 0) {
      // Otro conductor ganó. Su transacción ya marcó esta oferta como
      // «perdida», liberó a este conductor y le emitió el D2: aquí solo se
      // responde de forma inmediata a su intento.
      return { gano: false, motivo: 'reclamacion_perdida' as const };
    }

    await registrarTransicion(
      cliente, 'solicitud', solicitudId, null, 'EMITIDO', 'ACEPTADO', 'conductor', 'reclamacion_atomica',
    );
    await cliente.query(
      `UPDATE oferta SET resultado = 'aceptada', respondida_en = $3
       WHERE solicitud_id = $1 AND conductor_id = $2`,
      [solicitudId, conductorId, ahora],
    );
    // Taxi compartido: solo queda OCUPADO si con este pasajero se llena el
    // coche. Con plazas libres sigue DISPONIBLE y recibiendo ofertas.
    //
    // Pasa por liberarPresencia porque puede que ya ESTÉ en ese estado: si
    // aceptó estando DISPONIBLE (con plazas libres) y le siguen quedando, el
    // destino coincide con el origen. Pedir esa transición reventaba con
    // «Transición inválida DISPONIBLE → DISPONIBLE» justo al aceptar.
    await liberarPresencia(
      cliente, conductorId, 'conductor',
      (await estadoPorOcupacion(cliente, conductorId)) === 'OCUPADO'
        ? 'reclamacion_ganada_coche_lleno'
        : 'reclamacion_ganada_con_plazas',
    );

    // Perdedores: aviso en el mismo segundo, dentro de esta transacción.
    const perdedores = await cliente.query(
      `UPDATE oferta SET resultado = 'perdida', respondida_en = $2
       WHERE solicitud_id = $1 AND resultado IS NULL
       RETURNING conductor_id`,
      [solicitudId, ahora],
    );
    for (const fila of perdedores.rows) {
      await liberarPresencia(cliente, fila.conductor_id, 'sistema', 'reclamacion_perdida');
      await emisor.emitir({
        tipo: 'D2_reclamacion_resuelta',
        rol: 'conductor',
        solicitudId,
        conductorId: fila.conductor_id,
        datos: { resultado: 'perdida' },
      }, cliente);
    }

    // PIN de 4 dígitos generado al aceptar (R5): se muestra al cliente y lo
    // introduce el conductor al recoger.
    const pin = String(randomInt(0, 10_000)).padStart(4, '0');
    const viaje = await cliente.query(
      `INSERT INTO viaje (solicitud_id, conductor_id, pin) VALUES ($1, $2, $3) RETURNING id`,
      [solicitudId, conductorId, pin],
    );
    const viajeId: number = viaje.rows[0].id;

    await emisor.emitir({
      tipo: 'D2_reclamacion_resuelta',
      rol: 'conductor',
      solicitudId,
      conductorId,
      datos: { resultado: 'ganada', viajeId },
    }, cliente);

    const vehiculo = await cliente.query(
      `SELECT c.nombre, v.matricula, v.marca, v.color
       FROM conductor c LEFT JOIN vehiculo v ON v.conductor_id = c.id
       WHERE c.id = $1`,
      [conductorId],
    );
    await emisor.emitir({
      tipo: 'C2_conductor_asignado',
      rol: 'cliente',
      solicitudId,
      dispositivoClienteId: solicitud.dispositivoClienteId,
      datos: {
        conductor: vehiculo.rows[0]?.nombre,
        matricula: vehiculo.rows[0]?.matricula,
        marca: vehiculo.rows[0]?.marca,
        color: vehiculo.rows[0]?.color,
        pin,
        viajeId,
      },
    }, cliente);

    return { gano: true, viajeId };
  });

  if ('rechazo' in resultado) {
    throw new ErrorOfertaInvalida(resultado.rechazo);
  }
  return resultado;
}

// El conductor rechaza su oferta: queda libre para la siguiente y no vuelve
// a recibir esta solicitud.
export async function rechazarOferta(
  pool: pg.Pool,
  solicitudId: number,
  conductorId: number,
  ahora: Date = new Date(),
): Promise<void> {
  await enTransaccion(pool, async (cliente) => {
    await bloquearSolicitud(cliente, solicitudId);
    const res = await cliente.query(
      `UPDATE oferta SET resultado = 'rechazada', respondida_en = $3
       WHERE solicitud_id = $1 AND conductor_id = $2 AND resultado IS NULL`,
      [solicitudId, conductorId, ahora],
    );
    if (res.rowCount === 0) {
      throw new ErrorOfertaInvalida(
        `El conductor ${conductorId} no tiene ninguna oferta pendiente de la solicitud ${solicitudId}.`,
      );
    }
    await liberarPresencia(cliente, conductorId, 'conductor', 'oferta_rechazada');
  });
}

// Planificador de producción: avanza oleadas y caduca presencias cada pocos
// segundos. Las pruebas no lo usan: llaman a avanzarDespachos con reloj
// inyectado.
export function iniciarPlanificadorDespacho(
  pool: pg.Pool,
  emisor: EmisorEventos,
  intervaloMs = 5000,
): () => void {
  const temporizador = setInterval(() => {
    void (async () => {
      try {
        await avanzarDespachos(pool, emisor);
        await enTransaccion(pool, (cliente) => caducarPresencias(cliente));
      } catch (error) {
        console.error('Error del planificador de despacho:', error);
      }
    })();
  }, intervaloMs);
  return () => clearInterval(temporizador);
}
