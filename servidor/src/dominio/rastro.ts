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
  let metros = 0;
  for (const tramo of tramosCompletos) {
    for (let i = 1; i < tramo.length; i += 1) {
      metros += distanciaMetros(
        tramo[i - 1].lat, tramo[i - 1].lng, tramo[i].lat, tramo[i].lng,
      );
    }
  }

  return {
    desde,
    hasta,
    tramos: aligerar(tramosCompletos, maxPuntos),
    puntos: todos.length,
    metros: Math.round(metros),
  };
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
