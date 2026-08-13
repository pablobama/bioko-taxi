// «Voy en este taxi, mírame llegar» (migración 043).
//
// El pasajero abre un enlace y se lo manda a quien quiera; esa persona ve en
// vivo por dónde va y en qué coche, hasta que llega.
//
// No confundir con `solicitud.compartido`, que es el taxi compartido —varios
// pasajeros en un coche—. Aquí compartido es el VIAJE, con quien se queda
// fuera.

import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { leerParametroEntero } from './parametros.js';
import { estimarLlegada } from './reputacion.js';

// Estados en los que el viaje sigue vivo y tiene sentido seguirlo.
const EN_MARCHA = ['SOLICITADO', 'EMITIDO', 'ACEPTADO', 'EN_CAMINO', 'RECOGIDO'];

// El token se guarda hasheado. Viaja en una URL, y las URL acaban en el
// historial del navegador, en los registros del servidor y en capturas de
// pantalla; quien lea esta tabla no tiene por qué poder abrir los viajes de
// nadie. 24 bytes son 32 caracteres en base64url: imposible de adivinar y
// todavía cabe en un mensaje sin partirse.
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface Seguimiento {
  id: number;
  solicitudId: number;
  token: string;
  expiraEn: Date;
}

export interface Visita {
  telefono: string;
  primeraEn: Date;
  ultimaEn: Date;
}

// Abre el enlace, o devuelve el que ya estaba abierto. Es a propósito: pulsar
// «compartir» dos veces no puede dejar dos enlaces vivos, porque cortar uno
// dejaría el otro abierto sin que el pasajero lo supiera.
//
// Devuelve `null` si ya había uno y no se puede reconstruir su token —está
// hasheado, no se puede deshacer—; quien llama decide qué contar entonces.
export async function crearSeguimiento(
  cliente: pg.ClientBase,
  solicitudId: number,
  dispositivoId: number,
  graciaMin: number,
  ahora: Date = new Date(),
): Promise<Seguimiento | null> {
  const vivo = await cliente.query(
    `SELECT id FROM seguimiento
     WHERE solicitud_id = $1 AND revocado_en IS NULL AND expira_en > $2`,
    [solicitudId, ahora],
  );
  if (vivo.rowCount !== 0) return null;

  const token = randomBytes(24).toString('base64url');
  // La caducidad se recalcula al terminar el viaje (`cerrarSeguimientos`).
  // Este primer plazo es solo el techo de un viaje que se quede colgado sin
  // cerrarse nunca: un enlace eterno no puede existir.
  const expiraEn = new Date(ahora.getTime() + (6 * 60 + graciaMin) * 60_000);
  const fila = await cliente.query(
    `INSERT INTO seguimiento (solicitud_id, token_hash, dispositivo_id, expira_en)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [solicitudId, hash(token), dispositivoId, expiraEn],
  );
  return { id: Number(fila.rows[0].id), solicitudId, token, expiraEn };
}

export async function revocarSeguimiento(
  cliente: pg.ClientBase | pg.Pool,
  solicitudId: number,
  dispositivoId: number,
): Promise<boolean> {
  const res = await cliente.query(
    `UPDATE seguimiento SET revocado_en = now()
     WHERE solicitud_id = $1 AND dispositivo_id = $2 AND revocado_en IS NULL`,
    [solicitudId, dispositivoId],
  );
  return (res.rowCount ?? 0) > 0;
}

// Minutos desde que el viaje terminó, o null si sigue en marcha.
//
// Se mira al consultar, en vez de acortar la caducidad desde el sitio que
// cierra el viaje: así no hay que enganchar nada a las transiciones —que son
// el corazón del sistema y no se tocan por una funcionalidad de pantalla— y
// no queda un enlace vivo por una transición que se olvidó de avisar.
export async function terminadoHaceMin(
  cliente: pg.ClientBase | pg.Pool,
  solicitudId: number,
): Promise<number | null> {
  const res = await cliente.query(
    `SELECT extract(epoch from (now() - max(t.creado_en))) / 60 AS minutos
     FROM transicion t JOIN estado e ON e.nombre = t.estado_nuevo
     WHERE t.solicitud_id = $1 AND e.ambito = 'solicitud' AND e.es_terminal`,
    [solicitudId],
  );
  const minutos = res.rows[0]?.minutos;
  return minutos === null || minutos === undefined ? null : Number(minutos);
}

export interface SeguimientoVivo {
  id: number;
  solicitudId: number;
  expiraEn: Date;
}

export async function seguimientoPorToken(
  cliente: pg.ClientBase | pg.Pool,
  token: string,
  ahora: Date = new Date(),
): Promise<SeguimientoVivo | null> {
  const res = await cliente.query(
    `SELECT id, solicitud_id, expira_en FROM seguimiento
     WHERE token_hash = $1 AND revocado_en IS NULL AND expira_en > $2`,
    [hash(token), ahora],
  );
  if (res.rowCount === 0) return null;
  const f = res.rows[0];
  return { id: Number(f.id), solicitudId: Number(f.solicitud_id), expiraEn: new Date(f.expira_en) };
}

export async function registrarVisita(
  cliente: pg.ClientBase | pg.Pool,
  seguimientoId: number,
  dispositivoId: number,
  telefono: string,
): Promise<void> {
  await cliente.query(
    `INSERT INTO seguimiento_visita (seguimiento_id, dispositivo_id, telefono)
     VALUES ($1, $2, $3)
     ON CONFLICT (seguimiento_id, dispositivo_id)
       DO UPDATE SET ultima_en = now()`,
    [seguimientoId, dispositivoId, telefono],
  );
}

// Quién está mirando el viaje. Se le enseña al pasajero mientras va dentro:
// es su viaje, y un número que no reconoce es la señal de que su enlace anda
// donde no debería.
export async function visitasDe(
  cliente: pg.ClientBase | pg.Pool,
  solicitudId: number,
): Promise<Visita[]> {
  const res = await cliente.query(
    `SELECT v.telefono, v.primera_en, v.ultima_en
     FROM seguimiento_visita v JOIN seguimiento s ON s.id = v.seguimiento_id
     WHERE s.solicitud_id = $1
     ORDER BY v.ultima_en DESC`,
    [solicitudId],
  );
  return res.rows.map((f: { telefono: string; primera_en: Date; ultima_en: Date }) => ({
    telefono: f.telefono,
    primeraEn: new Date(f.primera_en),
    ultimaEn: new Date(f.ultima_en),
  }));
}

export interface VistaSeguida {
  estado: string;
  enMarcha: boolean;
  origen: string;
  destino: string;
  destinoLat: number;
  destinoLng: number;
  // Dónde va. Del propio pasajero si su móvil lo está mandando; si no, del
  // taxi, que es el coche en el que va — no es lo mismo, y se dice cuál es.
  posicion: { lat: number; lng: number; de: 'pasajero' | 'taxi'; frescuraSeg: number } | null;
  // Cuánto falta para llegar al destino, desde donde va ahora mismo. null si
  // no hay posición o si el viaje ya terminó.
  etaMin: number | null;
  distanciaM: number | null;
  // Con qué coche va. Es la mitad del valor de esto: quien mira quiere poder
  // decir «se subió al GE-1234 con Juan» si algo pasa.
  conductor: string | null;
  matricula: string | null;
  marca: string | null;
  color: string | null;
  expiraEn: string;
}

// Lo que ve quien sigue el viaje. Deliberadamente menos que lo que ve el
// pasajero: aquí NO van los teléfonos (ni el del pasajero ni el del
// conductor), ni el PIN de recogida —que es la prueba de identidad del
// viaje—, ni el precio, que no es asunto de quien mira.
export async function vistaSeguida(
  cliente: pg.ClientBase | pg.Pool,
  solicitudId: number,
  expiraEn: Date,
): Promise<VistaSeguida | null> {
  const res = await cliente.query(
    `SELECT s.estado, v.id AS viaje_id,
            ro.nombre AS origen,
            rd.nombre AS destino, rd.lat AS destino_lat, rd.lng AS destino_lng,
            c.nombre AS conductor, ve.matricula, ve.marca, ve.color
     FROM solicitud s
     JOIN referencia ro ON ro.id = s.referencia_origen_id
     JOIN referencia rd ON rd.id = s.referencia_destino_id
     LEFT JOIN viaje v ON v.solicitud_id = s.id
     LEFT JOIN conductor c ON c.id = s.conductor_id
     LEFT JOIN vehiculo ve ON ve.conductor_id = s.conductor_id
     WHERE s.id = $1`,
    [solicitudId],
  );
  if (res.rowCount === 0) return null;
  const f = res.rows[0];

  let posicion: VistaSeguida['posicion'] = null;
  if (f.viaje_id !== null) {
    // La última posición de CADA UNO, y luego se elige.
    //
    // Antes esto era un solo ORDER BY que ponía al pasajero primero pasara lo
    // que pasara, y ahí estaba el fallo que se vio en la prueba: el móvil del
    // pasajero solo manda posición mientras su pantalla está encendida, así que
    // en cuanto se lo guarda en el bolsillo, su última lectura se queda fija
    // para siempre —y las del taxi, que siguen llegando cada diez segundos, se
    // descartaban por ser «del taxi»—. Quien seguía el viaje veía un punto
    // congelado el resto del trayecto.
    const p = await cliente.query(
      `SELECT DISTINCT ON (actor)
              lat, lng, actor, extract(epoch from (now() - creado_en))::int AS antiguedad
       FROM posicion WHERE viaje_id = $1
       ORDER BY actor, creado_en DESC`,
      [f.viaje_id],
    );
    const filas = p.rows as Array<{ lat: number; lng: number; actor: string; antiguedad: number }>;
    const delPasajero = filas.find((x) => x.actor === 'cliente');
    const delTaxi = filas.find((x) => x.actor === 'conductor');

    // La del pasajero manda solo si está fresca: es SU ubicación la que se
    // está compartiendo y es la buena mientras exista. Rancia, vale más la del
    // coche en el que va, que sí se está moviendo.
    const frescuraSeg = await leerParametroEntero(cliente, 'gps_frescura_seg');
    const elegida = delPasajero !== undefined && delPasajero.antiguedad <= frescuraSeg
      ? delPasajero
      : (delTaxi ?? delPasajero);

    if (elegida !== undefined) {
      posicion = {
        lat: Number(elegida.lat),
        lng: Number(elegida.lng),
        de: elegida.actor === 'cliente' ? 'pasajero' : 'taxi',
        frescuraSeg: Number(elegida.antiguedad),
      };
    }
  }

  // Cuánto falta para que llegue. Es la pregunta entera de quien sigue el
  // viaje —«¿ha llegado ya?»— y no estaba: se enseñaba dónde va y nada sobre
  // cuándo. Se calcula igual que el que ve el pasajero en su propio mapa.
  let etaMin: number | null = null;
  let distanciaM: number | null = null;
  if (posicion !== null && EN_MARCHA.includes(f.estado)) {
    const estimacion = await estimarLlegada(
      cliente,
      { lat: posicion.lat, lng: posicion.lng },
      { lat: Number(f.destino_lat), lng: Number(f.destino_lng) },
    );
    etaMin = estimacion.minutos;
    distanciaM = estimacion.distanciaM;
  }

  return {
    estado: f.estado,
    enMarcha: EN_MARCHA.includes(f.estado),
    origen: f.origen,
    destino: f.destino,
    destinoLat: Number(f.destino_lat),
    destinoLng: Number(f.destino_lng),
    posicion,
    etaMin,
    distanciaM,
    conductor: f.conductor,
    matricula: f.matricula,
    marca: f.marca,
    color: f.color,
    expiraEn: expiraEn.toISOString(),
  };
}

export async function graciaMin(cliente: pg.ClientBase | pg.Pool): Promise<number> {
  return leerParametroEntero(cliente, 'seguimiento_gracia_min');
}

export { EN_MARCHA };
