// Reputación del conductor y tiempo estimado de llegada (migración 014).

import type pg from 'pg';
import { ErrorEntidadInexistente } from './errores.js';
import { distanciaMetros } from './geo.js';
import { leerParametroEntero } from './parametros.js';

export interface Reputacion {
  // null cuando aún no tiene valoraciones: se muestra «nuevo», nunca un 0 que
  // parecería una mala nota.
  media: number | null;
  valoraciones: number;
  viajesCompletados: number;
}

export async function reputacionDe(
  cliente: pg.ClientBase | pg.Pool,
  conductorId: number,
): Promise<Reputacion> {
  const res = await cliente.query(
    `SELECT round(avg(val.puntuacion)::numeric, 1) AS media,
            count(val.id)::int AS valoraciones,
            (SELECT count(*)::int FROM solicitud s
             WHERE s.conductor_id = $1 AND s.estado = 'COMPLETADO') AS viajes
     FROM valoracion val
     JOIN viaje v ON v.id = val.viaje_id
     WHERE v.conductor_id = $1 AND val.emisor = 'cliente'`,
    [conductorId],
  );
  const fila = res.rows[0];
  return {
    media: fila.media === null ? null : Number(fila.media),
    valoraciones: fila.valoraciones,
    viajesCompletados: fila.viajes,
  };
}

export interface Valoracion {
  puntuacion: number;
  motivo?: string;
}

// Valoración del cliente sobre un viaje. Idempotente por (viaje, emisor): un
// segundo envío no crea otra fila ni cambia la nota.
export async function valorarViaje(
  cliente: pg.ClientBase,
  viajeId: number,
  emisor: 'cliente' | 'conductor',
  valoracion: Valoracion,
): Promise<{ guardada: boolean }> {
  if (!Number.isInteger(valoracion.puntuacion)
    || valoracion.puntuacion < 1 || valoracion.puntuacion > 5) {
    throw new Error(`Puntuación no válida: ${valoracion.puntuacion}. Debe ser un entero de 1 a 5.`);
  }
  const existe = await cliente.query('SELECT 1 FROM viaje WHERE id = $1', [viajeId]);
  if (existe.rowCount === 0) {
    throw new ErrorEntidadInexistente('el viaje', viajeId);
  }
  const res = await cliente.query(
    `INSERT INTO valoracion (viaje_id, emisor, puntuacion, motivo)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (viaje_id, emisor) DO NOTHING`,
    [viajeId, emisor, valoracion.puntuacion, valoracion.motivo ?? null],
  );
  return { guardada: (res.rowCount ?? 0) > 0 };
}

export interface Estimacion {
  distanciaM: number;
  minutos: number;
}

// Tiempo estimado hasta un punto. SIN motor de rutas: línea recta corregida
// por un factor de desvío (las calles no son rectas) y una velocidad urbana
// media. Es una aproximación y así se presenta al usuario.
export async function estimarLlegada(
  cliente: pg.ClientBase | pg.Pool,
  desde: { lat: number; lng: number },
  hasta: { lat: number; lng: number },
): Promise<Estimacion> {
  const velocidadKmh = await leerParametroEntero(cliente, 'velocidad_urbana_kmh');
  const factorDecimas = await leerParametroEntero(cliente, 'eta_factor_desvio');

  const rectaM = distanciaMetros(desde.lat, desde.lng, hasta.lat, hasta.lng);
  const recorridoM = rectaM * (factorDecimas / 10);
  const minutos = Math.max(1, Math.round((recorridoM / 1000) / velocidadKmh * 60));
  return { distanciaM: Math.round(recorridoM), minutos };
}
