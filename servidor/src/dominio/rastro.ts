// Por dónde anduvo un taxi durante su turno (migración 042).
//
// Se alimenta del latido del taxista, que ya llegaba con coordenadas y se
// tiraba. Lo único que hace falta pensar aquí es CUÁNTO guardar: el latido
// llega cada 20 s, y a ese ritmo un mes de cien taxis no cabe en la base
// —ni haría falta, porque entre dos latidos de un taxi parado solo hay ruido
// de GPS—. Ver `debeGuardar` para la regla.

import type pg from 'pg';
import { caminoPorCarretera } from './carreteras.js';
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
  // Velocidad MEDIDA por el GPS en el instante de la lectura, en km/h
  // (migración 063). null o ausente cuando el teléfono no la dio: no se
  // inventa, se estima como antes.
  velocidadKmh?: number | null;
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

// Seguidas y no con Promise.all: sobre un mismo cliente, pg avisa de que las
// consultas simultáneas dejarán de funcionar en su próxima versión.
async function limites(cliente: pg.ClientBase | pg.Pool) {
  const intervaloSeg = await leerParametroEntero(cliente, 'rastro_intervalo_min_seg');
  const distanciaM = await leerParametroEntero(cliente, 'rastro_distancia_min_m');
  const anclajeSeg = await leerParametroEntero(cliente, 'rastro_anclaje_seg');
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
//   - Si el anterior es de hace menos del intervalo mínimo, no. Con el
//     latido cada 20 s y el mínimo en 15 (migración 056), un punto por latido
//     circulando; parado, el anclaje de abajo lo deja en uno cada cinco
//     minutos.
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
  // Radio de error de la lectura (migración 054). null si el cliente no lo
  // manda: se apunta igual, y queda a la vista como «no se sabe».
  precisionM: number | null = null,
  // Velocidad medida por el GPS (migración 063). Opcional por los teléfonos
  // que no la dan y por las versiones que ya están en la calle.
  velocidadKmh: number | null = null,
): Promise<boolean> {
  const enServicio = await cliente.query(
    `SELECT 1 FROM presencia WHERE conductor_id = $1 AND estado <> 'DESCONECTADO'`,
    [conductorId],
  );
  if (enServicio.rowCount === 0) return false;

  // Una lectura mala no entra. Va ANTES del aclarado a propósito: si entrara
  // en la comparación, un punto de antena podría ocupar el hueco de 45 s y
  // hacer que se descartara la buena lectura de GPS que llega justo después.
  if (!precisionAceptable(precisionM, await leerParametroEntero(cliente, 'rastro_precision_maxima_m'))) {
    return false;
  }

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

  // ON CONFLICT: el latido y el envío diferido pueden traer la misma lectura
  // con la misma hora ahora que los dos usan la hora del GPS (migración 054).
  const res = await cliente.query(
    `INSERT INTO rastro (conductor_id, lat, lng, creado_en, precision_m, velocidad_kmh)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [conductorId, lat, lng, ahora, precisionM, velocidadAceptable(velocidadKmh)],
  );
  return (res.rowCount ?? 0) > 0;
}

// Sin precisión se acepta —clientes viejos, pruebas— y con ella, solo por
// debajo del máximo. Un NaN o un negativo es un dato roto, no uno bueno.
// Una velocidad que no se puede creer no se guarda: fuera del rango del CHECK
// de la 063 el INSERT reventaría el latido entero por un dato raro, y un dato
// raro vale menos que el latido. Un NaN, un negativo o 400 km/h no son un
// taxi; un null es «el teléfono no lo dijo», que es distinto y se guarda tal
// cual.
export function velocidadAceptable(velocidadKmh: number | null | undefined): number | null {
  if (velocidadKmh === null || velocidadKmh === undefined) return null;
  if (!Number.isFinite(velocidadKmh)) return null;
  if (velocidadKmh < 0 || velocidadKmh > 300) return null;
  return velocidadKmh;
}

export function precisionAceptable(precisionM: number | null, maximaM: number): boolean {
  if (precisionM === null) return true;
  return Number.isFinite(precisionM) && precisionM >= 0 && precisionM <= maximaM;
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
  puntos: Array<{
    lat: number; lng: number; en: Date;
    precisionM?: number | null; velocidadKmh?: number | null;
  }>,
  ahora: Date = new Date(),
): Promise<{ guardados: number; descartados: number }> {
  if (puntos.length === 0) return { guardados: 0, descartados: 0 };

  const { intervaloSeg } = await limites(cliente);
  const precisionMaxima = await leerParametroEntero(cliente, 'rastro_precision_maxima_m');
  const retencionDias = await leerParametroEntero(cliente, 'rastro_retencion_dias');
  const masViejo = ahora.getTime() - retencionDias * 24 * 60 * 60 * 1000;
  // Un minuto de margen: los relojes de dos móviles no coinciden al segundo, y
  // tirar un punto por eso sería tirar trabajo de verdad.
  const masNuevo = ahora.getTime() + 60_000;

  const ordenados = [...puntos]
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)
      && p.en.getTime() >= masViejo && p.en.getTime() <= masNuevo
      && precisionAceptable(p.precisionM ?? null, precisionMaxima))
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
      `INSERT INTO rastro (conductor_id, lat, lng, creado_en, precision_m, velocidad_kmh)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [
        conductorId, punto.lat, punto.lng, punto.en, punto.precisionM ?? null,
        velocidadAceptable(punto.velocidadKmh),
      ],
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
    `SELECT lat, lng, creado_en, velocidad_kmh FROM rastro
     WHERE conductor_id = $1 AND creado_en >= $2 AND creado_en < $3
     ORDER BY creado_en`,
    [conductorId, desde, hasta],
  );
  const todos: PuntoRastro[] = filas.rows.map(
    (f: { lat: number; lng: number; creado_en: Date; velocidad_kmh: number | null }) => ({
      lat: Number(f.lat),
      lng: Number(f.lng),
      en: new Date(f.creado_en),
      velocidadKmh: f.velocidad_kmh === null ? null : Number(f.velocidad_kmh),
    }),
  );

  // Los metros se cuentan sobre TODOS los puntos, antes de aligerar: si se
  // midieran sobre la versión reducida, un mes recorrido saldría más corto
  // que una semana del mismo taxi solo por haberse dibujado con menos puntos.
  const tramosCompletos = trocear(todos);
  // Seguidas, no con Promise.all: son consultas sobre el MISMO cliente, y pg
  // ya avisa de que eso dejará de funcionar en su próxima versión.
  const ruidoM = await leerParametroEntero(cliente, 'rastro_ruido_m');
  const maximaKmh = await leerParametroEntero(cliente, 'rastro_velocidad_maxima_kmh');
  let metros = 0;
  let segundosEnMovimiento = 0;
  const trazados: Tramo[] = [];
  for (const tramo of tramosCompletos) {
    const andado = andarPorCalles(tramo, ruidoM, maximaKmh);
    metros += andado.metros;
    segundosEnMovimiento += andado.segundos;
    if (andado.trazado.length >= 2) {
      trazados.push(andado.trazado);
    } else {
      // Un tramo en el que no se movió de verdad —una hora esperando en la
      // parada del mercado— no suma metros, pero se sigue VIENDO dónde esperó.
      // Sin esto, al pasar el recorrido por las calles un taxi parado
      // desaparecía del mapa del operador, que es justo lo que quiere saber.
      trazados.push([{ ...tramo[0] }, { ...tramo[tramo.length - 1] }]);
    }
  }

  // La intensidad se cuenta sobre el camino POR LAS CALLES, denso y antes de
  // aligerar. Sobre los puntos guardados —uno cada 300 m, en un sitio distinto
  // en cada pasada— la misma calle recorrida tres veces salía pintada de una
  // sola pasada en una parte de su longitud. Y antes de aligerar porque, si no,
  // la ruta más repetida cambiaría según cuántos puntos quepan en la respuesta.
  const pasadas = pasadasPorCelda(trazados);
  let maxPasadas = 0;
  for (const tramo of trazados) {
    for (const punto of tramo) {
      punto.pasadas = pasadas.get(celdaDe(punto)) ?? 1;
      if (punto.pasadas > maxPasadas) maxPasadas = punto.pasadas;
    }
  }

  return {
    desde,
    hasta,
    tramos: aligerar(trazados, maxPuntos),
    puntos: todos.length,
    metros: Math.round(metros),
    segundosEnMovimiento: Math.round(segundosEnMovimiento),
    maxPasadas,
  };
}

// Cuánto anduvo de verdad en un tramo, por dónde y durante cuánto (migración
// 051 y diagnóstico del 15/09).
//
// DOS DEFENSAS contra lo que no se anduvo:
//
//   - Contra un ANCLA y con suelo de ruido. Un taxi parado deja un punto cada
//     cinco minutos a quince o veinte metros del anterior: temblor del chip. El
//     ancla no se mueve hasta que el coche se separa de ella más de `ruidoM`, y
//     así un atasco —que avanza de veinte en veinte metros— sí acumula.
//   - Sin saltos imposibles: una fijación disparada no es un coche.
//
// Y UNA CORRECCIÓN de lo que sí se anduvo: entre dos puntos no hay una recta,
// hay calles. El diagnóstico contra una ruta verdadera por Malabo midió lo que
// costaba la recta: un 30 % menos de kilómetros, la mitad de la velocidad real
// en marcha, y un cuarto del dibujo atravesando manzanas. Ahora cada salto se
// reconstruye por las calles (`caminoPorCarretera`) y solo si no hay un camino
// creíble se usa la recta.
//
// El tiempo en marcha de un salto es el que se tarda en recorrer ese camino a
// la velocidad típica de cada calle, sin pasar de lo que duró el salto. Es la
// forma de separar, dentro de un minuto entre dos puntos, cuánto fue andar y
// cuánto un semáforo — que antes contaba entero como volante.
function andarPorCalles(
  tramo: Tramo, ruidoM: number, maximaKmh: number,
): { metros: number; segundos: number; trazado: Tramo } {
  let metros = 0;
  let segundos = 0;
  let ancla = tramo[0];
  const trazado: Tramo = [{ ...ancla }];
  for (let i = 1; i < tramo.length; i += 1) {
    const punto = tramo[i];
    const salto = distanciaMetros(ancla.lat, ancla.lng, punto.lat, punto.lng);
    if (salto < ruidoM) continue;
    const hueco = Math.max(0, (punto.en.getTime() - ancla.en.getTime()) / 1000);
    if (hueco > 0 && (salto / hueco) * 3.6 > maximaKmh) {
      // Descartada la fijación, pero el ancla avanza igual: si se quedara
      // atrás, el punto siguiente se mediría contra un sitio donde el coche ya
      // no está y el error se arrastraría el resto del tramo. Y no se dibuja:
      // la vuelta desde el punto disparado también es imposible y cae aquí, así
      // que el pico desaparece entero del mapa.
      ancla = punto;
      continue;
    }

    const camino = caminoPorCarretera(ancla, punto, salto, hueco, maximaKmh);
    const tope = CORTE_TRAMO_MS / 1000;
    // Lo que MIDIÓ el GPS manda sobre lo que supone la tabla de velocidades
    // típicas del enrutador (migración 063). Solo sustituye al cálculo cuando
    // hay medida: sin ella, todo sigue igual que antes.
    const medida = velocidadMedida(ancla, punto);
    if (camino !== null) {
      metros += camino.distanciaM;
      segundos += Math.min(
        hueco,
        medida === null ? camino.segundosTipicos : camino.distanciaM / (medida / 3.6),
        tope,
      );
      densificar(trazado, camino.puntos, ancla.en, punto.en);
    } else {
      metros += salto;
      segundos += Math.min(
        hueco,
        medida === null ? hueco : salto / (medida / 3.6),
        tope,
      );
      densificar(trazado, [ancla, punto], ancla.en, punto.en);
    }
    ancla = punto;
  }
  return { metros, segundos, trazado };
}

// Por debajo de esto el coche está parado, no circulando despacio: es el
// temblor del chip con el motor en marcha. Sirve, sobre todo, para no dividir
// por una velocidad de 0,4 km/h y sacar un tiempo en marcha absurdo.
const PARADO_KMH = 3;

// A qué velocidad se fue de un punto al siguiente, SEGÚN EL GPS (migración
// 063), o null si no lo dijo.
//
// El receptor mide la velocidad por el efecto Doppler sobre la señal, no
// restando dos posiciones: sabe si el coche estaba parado en un semáforo
// aunque entre las dos lecturas haya pasado un minuto. Eso es justo lo que no
// se podía deducir y por lo que el tiempo al volante salía largo.
//
// Se promedian los dos extremos porque lo que se busca es la velocidad DEL
// TRAYECTO entre ellos, y esas dos lecturas son lo único que se sabe de él. Si
// solo una está, se usa esa: media información es más que ninguna. Y si de la
// media sale un coche parado, se devuelve null y se estima como siempre: hay
// metros de por medio, así que esas dos lecturas no describen el trayecto.
function velocidadMedida(a: PuntoRastro, b: PuntoRastro): number | null {
  const dos = [a.velocidadKmh, b.velocidadKmh]
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (dos.length === 0) return null;
  const media = dos.reduce((suma, v) => suma + v, 0) / dos.length;
  return media < PARADO_KMH ? null : media;
}

// Añade un camino al trazado con un punto cada 15 m como mucho, repartiendo la
// hora a lo largo de la distancia. Denso por el mapa de calor: sus celdas son
// de 33 m, y una avenida recta del plano puede ser un solo tramo de trescientos
// metros, que sin esto no pisaría las celdas de en medio.
const PASO_TRAZADO_M = 15;
function densificar(
  trazado: Tramo, camino: Array<{ lat: number; lng: number }>, desde: Date, hasta: Date,
): void {
  const largos = [0];
  for (let i = 1; i < camino.length; i += 1) {
    largos.push(largos[i - 1] + distanciaMetros(camino[i - 1].lat, camino[i - 1].lng, camino[i].lat, camino[i].lng));
  }
  const total = largos[largos.length - 1];
  const hora = (m: number) => new Date(
    desde.getTime() + (total === 0 ? 0 : m / total) * (hasta.getTime() - desde.getTime()),
  );
  for (let i = 1; i < camino.length; i += 1) {
    const a = camino[i - 1];
    const b = camino[i];
    const tramoM = largos[i] - largos[i - 1];
    const pasos = Math.max(1, Math.ceil(tramoM / PASO_TRAZADO_M));
    for (let k = 1; k <= pasos; k += 1) {
      const f = k / pasos;
      trazado.push({
        lat: a.lat + (b.lat - a.lat) * f,
        lng: a.lng + (b.lng - a.lng) * f,
        en: hora(largos[i - 1] + tramoM * f),
      });
    }
  }
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
// demás saldría azul. Contando pasadas, esperar no cuenta como recorrer.
//
// Y una pasada es ENTRAR EN LA CELDA DESPUÉS DE HABER ESTADO LEJOS, no cambiar
// de celda. Antes bastaba con salir y volver a entrar, y un camino que va por
// el borde entre dos celdas —cualquier calle que no caiga justo en medio de la
// rejilla— zigzaguea de una a otra cada pocos metros: el diagnóstico del 15/09
// encontró un tercio del mapa con MÁS pasadas de las reales por eso. Ahora
// hace falta haber recorrido `LEJOS_M` fuera de la celda para que volver
// cuente como otra vez; una vuelta a la manzana sí la cumple, un zigzag no.
const LEJOS_M = 80;
function pasadasPorCelda(tramos: Tramo[]): Map<string, number> {
  const cuenta = new Map<string, number>();
  for (const tramo of tramos) {
    const vistaEn = new Map<string, number>();
    let andado = 0;
    for (let i = 0; i < tramo.length; i += 1) {
      const punto = tramo[i];
      if (i > 0) {
        andado += distanciaMetros(tramo[i - 1].lat, tramo[i - 1].lng, punto.lat, punto.lng);
      }
      const celda = celdaDe(punto);
      const ultima = vistaEn.get(celda);
      if (ultima === undefined || andado - ultima > LEJOS_M) {
        cuenta.set(celda, (cuenta.get(celda) ?? 0) + 1);
      }
      vistaEn.set(celda, andado);
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

// Un latido de un taxista en servicio, apuntado por minuto (migración 055).
//
// Del latido solo se guardaba el último, y eso hacía imposible explicar un
// hueco en el recorrido después: el turno de 12:38 a 15:28 del 14/09 tiene un
// solo punto y no hay forma de saber si la aplicación no latía, si latía sin
// posición o si latía con posición y no se guardó. Son tres fallos distintos
// con tres arreglos distintos.
//
// Por minuto y no por latido: con lo que cuenta —latidos, cuántos con
// posición, la mejor precisión— basta para distinguir los tres casos, y es una
// fila por minuto como mucho en vez de seis.
export async function apuntarSenal(
  cliente: pg.ClientBase,
  conductorId: number,
  conPosicion: boolean,
  precisionM: number | null,
  ahora: Date = new Date(),
): Promise<void> {
  await cliente.query(
    `INSERT INTO senal (conductor_id, minuto, latidos, con_posicion, mejor_precision_m)
     SELECT $1, date_trunc('minute', $2::timestamptz), 1, $3::int, $4
     WHERE EXISTS (
       SELECT 1 FROM presencia WHERE conductor_id = $1 AND estado <> 'DESCONECTADO'
     )
     ON CONFLICT (conductor_id, minuto) DO UPDATE SET
       latidos = senal.latidos + 1,
       con_posicion = senal.con_posicion + EXCLUDED.con_posicion,
       mejor_precision_m = LEAST(senal.mejor_precision_m, EXCLUDED.mejor_precision_m)`,
    [conductorId, ahora, conPosicion ? 1 : 0, precisionM],
  );
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
  // La señal se va con el rastro: solo sirve para explicar sus huecos.
  await pool.query('DELETE FROM senal WHERE minuto < $1', [corte]);
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
