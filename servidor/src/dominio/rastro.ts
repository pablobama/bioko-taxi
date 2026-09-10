// Por dónde anduvo un taxi durante su turno (migración 042).
//
// Se alimenta del latido del taxista, que ya llegaba con coordenadas y se
// tiraba. Lo único que hace falta pensar aquí es CUÁNTO guardar: el latido
// llega cada 20 s, y a ese ritmo un mes de cien taxis no cabe en la base
// —ni haría falta, porque entre dos latidos de un taxi parado solo hay ruido
// de GPS—. Ver `debeGuardar` para la regla.

import type pg from 'pg';
import { distanciaMetros } from './geo.js';
import { leerParametroEntero } from './parametros.js';

export interface PuntoRastro {
  lat: number;
  lng: number;
  en: Date;
  // Cuántas veces pasó el taxi por la celda de este punto en el periodo. Es lo
  // que pinta el mapa de calor: la ruta que repite todos los días sale roja y
  // la que hizo una vez, azul.
  pasadas?: number;
}

// Un recorrido no es una línea: es una línea con agujeros. El taxista sale de
// servicio a comer, se le va la cobertura en la subida a Basilé, apaga el
// móvil. Unir esos extremos con una recta dibujaría un viaje que no existió,
// atravesando media ciudad. Cada tramo es un trozo continuo.
export type Tramo = PuntoRastro[];

export interface Recorrido {
  desde: Date;
  hasta: Date;
  tramos: Tramo[];
  puntos: number;
  metros: number;
  // Segundos del periodo en los que el coche estaba andando. Sale de la misma
  // pasada que los metros: cada trozo que cuenta como distancia cuenta también
  // su duración, y el rato parado no cuenta ni lo uno ni lo otro.
  segundosEnMovimiento: number;
  // La celda más repetida del periodo. Sirve para normalizar el color en el
  // cliente: sin esto, «tres pasadas» no significa nada — puede ser mucho o
  // casi nada según el taxista y el periodo.
  maxPasadas: number;
}

// Un hueco de más de esto empieza tramo nuevo. Diez minutos es más que
// cualquier hueco normal (el anclaje escribe cada cinco aunque el coche no se
// mueva) y menos que cualquier parada de verdad.
const CORTE_TRAMO_MS = 10 * 60 * 1000;

async function limites(cliente: pg.ClientBase | pg.Pool) {
  const [intervaloSeg, distanciaM, anclajeSeg] = await Promise.all([
    leerParametroEntero(cliente, 'rastro_intervalo_min_seg'),
    leerParametroEntero(cliente, 'rastro_distancia_min_m'),
    leerParametroEntero(cliente, 'rastro_anclaje_seg'),
  ]);
  return { intervaloSeg, distanciaM, anclajeSeg };
}

// Guarda un punto del recorrido, o no. Devuelve si lo guardó, que es lo que
// hace las pruebas legibles.
//
// Lo primero es el estado: DESCONECTADO no se rastrea. Hoy la app del taxista
// ya deja de mandar latidos al salir de servicio, pero eso es una promesa del
// cliente, y un cliente se puede modificar. La única garantía de que su vida
// fuera del turno no se registra tiene que estar en el servidor, y está aquí.
//
// Después, cuánto guardar:
//   - Si no hay punto anterior, se guarda: es el principio del turno.
//   - Si el anterior es de hace menos del intervalo mínimo, no. Esto es lo
//     que corta de 180 puntos por hora a 80 como mucho.
//   - Si se ha movido lo bastante, sí. Este es el caso normal circulando.
//   - Si no se ha movido pero hace rato del último, sí: es la diferencia
//     entre «estuvo una hora parado en la parada del mercado» y «no se sabe».
//   - Si no, no: el coche está parado y ya hay un punto reciente diciéndolo.
export async function registrarRastro(
  cliente: pg.ClientBase,
  conductorId: number,
  lat: number,
  lng: number,
  ahora: Date = new Date(),
): Promise<boolean> {
  const enServicio = await cliente.query(
    `SELECT 1 FROM presencia WHERE conductor_id = $1 AND estado <> 'DESCONECTADO'`,
    [conductorId],
  );
  if (enServicio.rowCount === 0) return false;

  const { intervaloSeg, distanciaM, anclajeSeg } = await limites(cliente);

  const ultimo = await cliente.query(
    `SELECT lat, lng, creado_en FROM rastro
     WHERE conductor_id = $1 ORDER BY creado_en DESC LIMIT 1`,
    [conductorId],
  );

  if (ultimo.rowCount !== 0) {
    const fila = ultimo.rows[0] as { lat: number; lng: number; creado_en: Date };
    const segundos = (ahora.getTime() - new Date(fila.creado_en).getTime()) / 1000;
    if (segundos < intervaloSeg) return false;
    const metros = distanciaMetros(
      Number(fila.lat), Number(fila.lng), lat, lng,
    );
    if (metros < distanciaM && segundos < anclajeSeg) return false;
  }

  await cliente.query(
    'INSERT INTO rastro (conductor_id, lat, lng, creado_en) VALUES ($1, $2, $3, $4)',
    [conductorId, lat, lng, ahora],
  );
  return true;
}

// El recorrido que el móvil apuntó sin cobertura y sube después (migración
// 051).
//
// Hasta ahora el rastro era un efecto secundario del latido: sin red no había
// latido, y sin latido ese trozo del turno no existía. En Malabo eso no es un
// caso raro —un barrio sin cobertura, la subida a Basilé, los datos agotados a
// mitad de mes— y el taxista veía su recorrido con agujeros de media tarde.
//
// La diferencia con `registrarRastro` es que aquí cada punto trae SU hora, no
// la de llegada. Y eso obliga a cuatro cosas:
//
//   - Comprobar el turno contra el REGISTRO, no contra la presencia de ahora.
//     Un lote de anoche se sube esta mañana, con el taxista ya fuera de
//     servicio; mirar su estado actual lo tiraría entero. Y al revés importa
//     más: sin esta comprobación bastaría con retrasar el reloj del móvil para
//     colar en el sistema por dónde anduvo alguien fuera de su turno.
//   - No fiarse de la hora del móvil más allá de lo razonable: nada del futuro
//     ni más viejo que la retención.
//   - Aguantar el reenvío. Si la respuesta se pierde por el camino el móvil
//     manda el lote otra vez, y tiene que salir lo mismo: de eso se encarga el
//     índice único de la 051 y el ON CONFLICT.
//   - Y aclarar los puntos igual que el directo, o un cliente modificado podría
//     subir un punto por segundo y llenar la tabla que más crece de la base.
//
// Devuelve cuántos guardó de verdad, que es lo que el móvil necesita saber
// para borrar su cola con tranquilidad.
export async function registrarRastroDiferido(
  cliente: pg.ClientBase,
  conductorId: number,
  puntos: Array<{ lat: number; lng: number; en: Date }>,
  ahora: Date = new Date(),
): Promise<{ guardados: number; descartados: number }> {
  if (puntos.length === 0) return { guardados: 0, descartados: 0 };

  const { intervaloSeg } = await limites(cliente);
  const retencionDias = await leerParametroEntero(cliente, 'rastro_retencion_dias');
  const masViejo = ahora.getTime() - retencionDias * 24 * 60 * 60 * 1000;
  // Un minuto de margen: los relojes de dos móviles no coinciden al segundo, y
  // tirar un punto por eso sería tirar trabajo de verdad.
  const masNuevo = ahora.getTime() + 60_000;

  const ordenados = [...puntos]
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)
      && p.en.getTime() >= masViejo && p.en.getTime() <= masNuevo)
    .sort((a, b) => a.en.getTime() - b.en.getTime());
  if (ordenados.length === 0) return { guardados: 0, descartados: puntos.length };

  const desde = ordenados[0].en;
  const hasta = ordenados[ordenados.length - 1].en;

  // Los ratos en los que estuvo en servicio, del registro de estados. Un punto
  // que no caiga dentro de ninguno no se guarda.
  const turnos = await cliente.query(
    `WITH marcas AS (
       SELECT estado_nuevo, COALESCE(ocurrio_en, creado_en) AS en, id
       FROM transicion
       WHERE ambito = 'conductor' AND conductor_id = $1
     )
     SELECT inicio, fin FROM (
       SELECT estado_nuevo, en AS inicio, lead(en) OVER (ORDER BY en, id) AS fin
       FROM marcas
     ) t
     WHERE estado_nuevo <> 'DESCONECTADO'
       AND inicio <= $3::timestamptz
       AND (fin IS NULL OR fin >= $2::timestamptz)`,
    [conductorId, desde, hasta],
  );
  const enTurno = (cuando: Date) => turnos.rows.some(
    (t: { inicio: Date; fin: Date | null }) =>
      new Date(t.inicio).getTime() <= cuando.getTime()
      && (t.fin === null || new Date(t.fin).getTime() >= cuando.getTime()),
  );

  // Lo que ya hay guardado en ese rango, más el punto justo anterior: sin ese
  // último, un lote que empieza treinta segundos después del último punto ya
  // guardado colaría un punto de más.
  const existentes = await cliente.query(
    `SELECT creado_en FROM rastro
     WHERE conductor_id = $1
       AND creado_en >= $2::timestamptz - make_interval(secs => $4)
       AND creado_en <= $3
     ORDER BY creado_en`,
    [conductorId, desde, hasta, intervaloSeg],
  );
  const horas = existentes.rows.map(
    (f: { creado_en: Date }) => new Date(f.creado_en).getTime(),
  );

  let guardados = 0;
  for (const punto of ordenados) {
    if (!enTurno(punto.en)) continue;
    const cuando = punto.en.getTime();
    // Contra el vecino más cercano en el tiempo, mire hacia atrás o hacia
    // delante: un lote puede llegar entremedias de lo ya guardado.
    const pegado = horas.some((h) => Math.abs(h - cuando) < intervaloSeg * 1000);
    if (pegado) continue;
    const res = await cliente.query(
      `INSERT INTO rastro (conductor_id, lat, lng, creado_en)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [conductorId, punto.lat, punto.lng, punto.en],
    );
    if (res.rowCount !== 0) {
      guardados += 1;
      horas.push(cuando);
    }
  }
  return { guardados, descartados: puntos.length - guardados };
}

export async function recorridoDe(
  cliente: pg.ClientBase | pg.Pool,
  conductorId: number,
  desde: Date,
  hasta: Date,
  maxPuntos = 1500,
): Promise<Recorrido> {
  const filas = await cliente.query(
    `SELECT lat, lng, creado_en FROM rastro
     WHERE conductor_id = $1 AND creado_en >= $2 AND creado_en < $3
     ORDER BY creado_en`,
    [conductorId, desde, hasta],
  );
  const todos: PuntoRastro[] = filas.rows.map(
    (f: { lat: number; lng: number; creado_en: Date }) => ({
      lat: Number(f.lat), lng: Number(f.lng), en: new Date(f.creado_en),
    }),
  );

  // Los metros se cuentan sobre TODOS los puntos, antes de aligerar: si se
  // midieran sobre la versión reducida, un mes recorrido saldría más corto
  // que una semana del mismo taxi solo por haberse dibujado con menos puntos.
  const tramosCompletos = trocear(todos);
  const [ruidoM, maximaKmh] = await Promise.all([
    leerParametroEntero(cliente, 'rastro_ruido_m'),
    leerParametroEntero(cliente, 'rastro_velocidad_maxima_kmh'),
  ]);
  let metros = 0;
  let segundosEnMovimiento = 0;
  for (const tramo of tramosCompletos) {
    const andado = metrosDe(tramo, ruidoM, maximaKmh);
    metros += andado.metros;
    segundosEnMovimiento += andado.segundos;
  }

  // La intensidad se calcula sobre TODOS los puntos y antes de aligerar: si se
  // contara sobre los que se dibujan, la ruta más repetida cambiaría según
  // cuántos puntos quepan en la respuesta.
  const pasadas = pasadasPorCelda(tramosCompletos);
  let maxPasadas = 0;
  for (const tramo of tramosCompletos) {
    for (const punto of tramo) {
      punto.pasadas = pasadas.get(celdaDe(punto)) ?? 1;
      if (punto.pasadas > maxPasadas) maxPasadas = punto.pasadas;
    }
  }

  return {
    desde,
    hasta,
    tramos: aligerar(tramosCompletos, maxPuntos),
    puntos: todos.length,
    metros: Math.round(metros),
    segundosEnMovimiento: Math.round(segundosEnMovimiento),
    maxPasadas,
  };
}

// Cuántos metros anduvo de verdad en un tramo (migración 051).
//
// Sumar la distancia entre cada dos puntos seguidos cuenta también lo que no
// se anduvo. Un taxi esperando en la parada del mercado deja un punto de
// anclaje cada cinco minutos, y entre dos de esos puntos hay quince o veinte
// metros de puro temblor del chip; doce puntos por hora, ocho horas de turno,
// y son kilómetro y medio de «recorrido» sin haberse movido del sitio.
//
// Así que la cuenta no va de punto a punto sino contra un ANCLA: mientras el
// coche no se separe de ella más de `ruidoM`, no se cuenta nada y el ancla se
// queda donde está. En cuanto se separa, se suma esa distancia y el ancla pasa
// a ser el punto nuevo.
//
// El ancla es lo que lo hace correcto y no solo un filtro: si se descartara
// cada salto pequeño sin más, un coche en un atasco —que avanza de veinte en
// veinte metros— no recorrería nada en toda la tarde. Contra el ancla, esos
// avances se acumulan y en cuanto suman lo bastante, cuentan enteros.
//
// Y un salto que implique una velocidad imposible tampoco cuenta: eso no es un
// coche, es una fijación disparada, y sumarla mete kilómetros de la nada.
function metrosDe(
  tramo: Tramo, ruidoM: number, maximaKmh: number,
): { metros: number; segundos: number } {
  let metros = 0;
  let segundos = 0;
  let ancla = tramo[0];
  for (let i = 1; i < tramo.length; i += 1) {
    const punto = tramo[i];
    const salto = distanciaMetros(ancla.lat, ancla.lng, punto.lat, punto.lng);
    if (salto < ruidoM) continue;
    const hueco = (punto.en.getTime() - ancla.en.getTime()) / 1000;
    if (hueco > 0 && (salto / hueco) * 3.6 > maximaKmh) {
      // Descartada la fijación, pero el ancla avanza igual: si se quedara
      // atrás, el punto siguiente se mediría contra un sitio donde el coche ya
      // no está y el error se arrastraría el resto del tramo.
      ancla = punto;
      continue;
    }
    metros += salto;
    // Y ese trozo cuenta también como tiempo circulando. Contra el ancla, igual
    // que la distancia: si el coche estuvo parado y luego arrancó, la espera
    // cae dentro de este mismo salto y no es conducción. Se acota al corte de
    // tramo para que un hueco largo no se cuele entero como volante.
    segundos += Math.min(Math.max(0, hueco), CORTE_TRAMO_MS / 1000);
    ancla = punto;
  }
  return { metros, segundos };
}

// Rejilla de ~33 m. Más fina y el ruido del GPS parte en dos celdas distintas
// dos pasadas por la misma calle; más gruesa y dos calles paralelas cuentan
// como una.
const CELDA_GRADOS = 0.0003;

const celdaDe = (p: { lat: number; lng: number }) =>
  `${Math.round(p.lat / CELDA_GRADOS)}:${Math.round(p.lng / CELDA_GRADOS)}`;

// Cuántas veces PASÓ por cada celda, que no es lo mismo que cuántos puntos
// dejó en ella.
//
// La diferencia es la funcionalidad entera. Un taxi esperando una hora en la
// parada del mercado deja doce puntos de anclaje en la misma celda; contando
// puntos, esa parada sería lo más «recorrido» del mes por goleada y todo lo
// demás saldría azul. Contando pasadas —cada racha seguida de puntos en la
// misma celda vale uno— esperar no cuenta como recorrer, que es lo que
// cualquiera entiende al mirar el mapa.
function pasadasPorCelda(tramos: Tramo[]): Map<string, number> {
  const cuenta = new Map<string, number>();
  for (const tramo of tramos) {
    let anterior = '';
    for (const punto of tramo) {
      const celda = celdaDe(punto);
      if (celda === anterior) continue;
      cuenta.set(celda, (cuenta.get(celda) ?? 0) + 1);
      anterior = celda;
    }
  }
  return cuenta;
}

function trocear(puntos: PuntoRastro[]): Tramo[] {
  const tramos: Tramo[] = [];
  let actual: Tramo = [];
  for (const punto of puntos) {
    const previo = actual[actual.length - 1];
    if (previo !== undefined
        && punto.en.getTime() - previo.en.getTime() > CORTE_TRAMO_MS) {
      tramos.push(actual);
      actual = [];
    }
    actual.push(punto);
  }
  if (actual.length > 0) tramos.push(actual);
  // Un tramo de un punto suelto no es un recorrido, es un coche parado un
  // momento. No se dibuja: no hay línea que trazar.
  return tramos.filter((t) => t.length >= 2);
}

// Un mes de un taxi que trabaje a diario son decenas de miles de puntos. Al
// móvil del operador no le hacen falta para ver por dónde anduvo, y mandarlos
// cuesta datos que aquí se pagan caros. Se queda uno de cada N, siempre con
// los extremos de cada tramo, que son los que dicen dónde empezó y acabó.
function aligerar(tramos: Tramo[], maxPuntos: number): Tramo[] {
  const total = tramos.reduce((n, t) => n + t.length, 0);
  if (total <= maxPuntos) return tramos;
  const paso = Math.ceil(total / maxPuntos);
  return tramos.map((tramo) => {
    const reducido = tramo.filter((_, i) => i % paso === 0);
    const ultimo = tramo[tramo.length - 1];
    if (reducido[reducido.length - 1] !== ultimo) reducido.push(ultimo);
    return reducido;
  });
}

// Se ejecuta sola cada pocas horas. Sin esto, la tabla que más crece de toda
// la base no para nunca.
export async function purgarRastro(
  pool: pg.Pool,
  ahora: Date = new Date(),
): Promise<number> {
  const dias = await leerParametroEntero(pool, 'rastro_retencion_dias');
  const corte = new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000);
  const res = await pool.query('DELETE FROM rastro WHERE creado_en < $1', [corte]);
  return res.rowCount ?? 0;
}

// --- Actividad: cuánto anduvo y cuánto tiempo estuvo (migración 042) --------

export interface Actividad {
  metros: number;
  segundosEnServicio: number;
  // Del turno, cuánto pasó CIRCULANDO. Las dos cifras dicen cosas distintas y
  // hacen falta las dos: ocho horas de turno con una de volante es un día malo
  // de espera, y ocho con seis es un día de trabajo. Con una sola no se
  // distinguen, y era justo lo que faltaba para leer el turno.
  segundosEnMovimiento: number;
  // Kilómetros por hora de TURNO, no de conducción: incluye el rato parado en
  // la parada esperando. Es lo que interesa —dice cuánto cunde una hora de
  // trabajo, no lo rápido que conduce— y por eso la etiqueta dice «de media en
  // servicio» y no «velocidad». null sin turno que medir.
  velocidadMediaKmh: number | null;
}

// El tiempo EN SERVICIO no se saca del rastro sino del registro de estados del
// conductor, y la diferencia importa: el rastro tiene agujeros —el móvil se
// queda sin cobertura, iOS suspende la aplicación al bloquear la pantalla
// (P47-01)— y contar solo lo que tiene puntos le quitaría al taxista horas que
// sí estuvo trabajando. El registro de transiciones no tiene ese problema:
// dice cuándo entró y cuándo salió, y `caducarPresencias` cierra el turno del
// que se quedó sin batería — apuntando, desde la migración 051, que el turno
// terminó en la última señal y no doce horas después, que es cuando el sistema
// se entera.
//
// Un tramo abierto (todavía en servicio) se corta en `hasta`, no en «ahora»:
// pedir el mes pasado no puede sumar el turno de hoy.
export async function actividadDe(
  cliente: pg.ClientBase | pg.Pool,
  conductorId: number,
  desde: Date,
  hasta: Date,
): Promise<Actividad> {
  const { metros, segundosEnMovimiento } = await recorridoDe(
    cliente, conductorId, desde, hasta,
  );

  const res = await cliente.query(
    `WITH marcas AS (
       -- \`ocurrio_en\` es cuándo pasó de verdad; \`creado_en\`, cuándo se apuntó
       -- (migración 051). Solo se separan en el turno que se da por abandonado
       -- doce horas después de la última señal, y ahí la diferencia son esas
       -- doce horas de servicio que no existieron.
       SELECT estado_nuevo, COALESCE(ocurrio_en, creado_en) AS en, id
       FROM transicion
       WHERE ambito = 'conductor' AND conductor_id = $1
     ), tramos AS (
       SELECT estado_nuevo,
              en AS inicio,
              lead(en) OVER (ORDER BY en, id) AS fin
       FROM marcas
     )
     SELECT COALESCE(sum(EXTRACT(epoch FROM (
              LEAST(COALESCE(fin, $3::timestamptz), $3::timestamptz)
              - GREATEST(inicio, $2::timestamptz)
            ))), 0)::bigint AS segundos
     FROM tramos
     WHERE estado_nuevo <> 'DESCONECTADO'
       AND COALESCE(fin, $3::timestamptz) > $2::timestamptz
       AND inicio < $3::timestamptz`,
    [conductorId, desde, hasta],
  );
  const segundosEnServicio = Math.max(0, Number(res.rows[0].segundos));
  return {
    metros,
    segundosEnServicio,
    segundosEnMovimiento,
    // Menos de un minuto de turno no da una media que signifique nada: un
    // arranque de veinte segundos saldría a ochenta por hora.
    velocidadMediaKmh: segundosEnServicio < 60
      ? null
      : Math.round((metros / 1000) / (segundosEnServicio / 3600) * 10) / 10,
  };
}
