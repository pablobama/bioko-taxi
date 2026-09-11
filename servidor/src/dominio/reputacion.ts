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
// por un factor de desvío (las calles no son rectas) y una velocidad. Es una
// aproximación y así se presenta al usuario, con un «unos» delante.
//
// La velocidad no es una sola (migración 052). Antes todo iba a la urbana, 18
// por hora, que es lo que se anda en Malabo entre semáforos, baches y gente
// cruzando. Aplicado a Malabo–Luba daba 142 minutos para un trayecto de unos
// cuarenta, y ese número lo vio un pasajero que estaba compartiendo su viaje.
//
// Se parte en dos tramos y no se interpola: los primeros kilómetros a
// velocidad de ciudad —salir de Malabo cuesta lo que cuesta, se vaya donde se
// vaya— y el resto a velocidad de carretera. Un trayecto corto dentro del
// casco queda exactamente igual que antes, que es lo que se quería: esa parte
// estaba bien calibrada y es la que se usa cien veces al día.
export async function estimarLlegada(
  cliente: pg.ClientBase | pg.Pool,
  desde: { lat: number; lng: number },
  hasta: { lat: number; lng: number },
): Promise<Estimacion> {
  const urbanaKmh = await leerParametroEntero(cliente, 'velocidad_urbana_kmh');
  const interurbanaKmh = await leerParametroEntero(cliente, 'velocidad_interurbana_kmh');
  const tramoUrbanoKm = await leerParametroEntero(cliente, 'eta_tramo_urbano_km');
  const factorDecimas = await leerParametroEntero(cliente, 'eta_factor_desvio');

  const rectaM = distanciaMetros(desde.lat, desde.lng, hasta.lat, hasta.lng);
  const recorridoKm = (rectaM * (factorDecimas / 10)) / 1000;

  const enCiudadKm = Math.min(recorridoKm, tramoUrbanoKm);
  const enCarreteraKm = Math.max(0, recorridoKm - tramoUrbanoKm);
  const horas = enCiudadKm / urbanaKmh + enCarreteraKm / interurbanaKmh;

  return {
    distanciaM: Math.round(recorridoKm * 1000),
    minutos: Math.max(1, Math.round(horas * 60)),
  };
}
