// Lo que el pasajero dice que pagó, y las bandas que salen de ahí
// (migración 066).
//
// Contexto imprescindible para no deshacer una decisión buena: la migración
// 012 quitó el reporte de precio porque obligar a los dos a teclear una cifra
// al terminar era fricción a cambio de nada —la plataforma vive de la
// suscripción y el dinero no pasa por aquí—. Eso sigue valiendo. Aquí el
// precio es VOLUNTARIO y de un toque, solo del pasajero, y sirve para dos
// cosas que sin él no se pueden hacer: que la banda de cada ruta deje de ser
// una suposición (P12-01) y que se pueda mirar el abuso de tarifa (P12-02).
//
// La banda NO es una tarifa. El precio lo negocian pasajero y conductor.

import type pg from 'pg';
import { leerParametroEntero } from './parametros.js';

export interface BandaCalculada {
  p25: number;
  p50: number;
  p75: number;
  muestras: number;
}

// Percentil por el método más simple y más explicable: se ordena y se coge el
// elemento que toca. Con cinco o veinte respuestas, cualquier interpolación
// fina es precisión inventada.
export function percentil(ordenados: number[], fraccion: number): number {
  if (ordenados.length === 0) throw new Error('No hay muestras para el percentil.');
  const indice = Math.min(
    ordenados.length - 1,
    Math.max(0, Math.round(fraccion * (ordenados.length - 1))),
  );
  return ordenados[indice];
}

export function bandaDeLosPrecios(importes: number[]): BandaCalculada | null {
  if (importes.length === 0) return null;
  const ordenados = [...importes].sort((a, b) => a - b);
  return {
    p25: percentil(ordenados, 0.25),
    p50: percentil(ordenados, 0.5),
    p75: percentil(ordenados, 0.75),
    muestras: ordenados.length,
  };
}

// Guarda lo que declaró el pasajero. Idempotente por (viaje, emisor): un
// segundo envío no cambia la cifra, igual que la valoración.
export async function declararPrecio(
  cliente: pg.ClientBase,
  viajeId: number,
  emisor: 'cliente' | 'conductor',
  importeXaf: number,
): Promise<{ guardado: boolean }> {
  if (!Number.isInteger(importeXaf) || importeXaf < 0 || importeXaf > 1_000_000) {
    throw new Error(`Importe no válido: ${importeXaf}. El dinero es entero y en XAF.`);
  }
  const res = await cliente.query(
    `INSERT INTO precio_declarado (viaje_id, emisor, importe_xaf)
     VALUES ($1, $2, $3) ON CONFLICT (viaje_id, emisor) DO NOTHING`,
    [viajeId, emisor, importeXaf],
  );
  return { guardado: (res.rowCount ?? 0) > 0 };
}

// Recalcula la banda del par de zonas de ese viaje con lo declarado en la
// ventana, si hay respuestas suficientes.
//
// Con menos de `banda_muestras_minimas` NO se toca nada: la que escribió el
// operador es criterio de campo, y tres cifras sueltas no son mejores que su
// criterio. Cuando hay datos, sí manda el dato — y `muestras` deja a la vista
// cuál es cuál.
export async function recalcularBandaDe(
  cliente: pg.ClientBase,
  viajeId: number,
): Promise<BandaCalculada | null> {
  const zonas = await cliente.query(
    `SELECT COALESCE(zo.zona_padre_id, zo.id) AS origen,
            COALESCE(zd.zona_padre_id, zd.id) AS destino
     FROM viaje v
     JOIN solicitud s ON s.id = v.solicitud_id
     JOIN referencia ro ON ro.id = s.referencia_origen_id
     JOIN referencia rd ON rd.id = s.referencia_destino_id
     JOIN zona zo ON zo.id = ro.zona_id
     JOIN zona zd ON zd.id = rd.zona_id
     WHERE v.id = $1`,
    [viajeId],
  );
  if (zonas.rowCount === 0) return null;
  const { origen, destino } = zonas.rows[0];

  const minimas = await leerParametroEntero(cliente, 'banda_muestras_minimas');
  const ventanaDias = await leerParametroEntero(cliente, 'banda_ventana_dias');

  const precios = await cliente.query(
    `SELECT pd.importe_xaf
     FROM precio_declarado pd
     JOIN viaje v ON v.id = pd.viaje_id
     JOIN solicitud s ON s.id = v.solicitud_id
     JOIN referencia ro ON ro.id = s.referencia_origen_id
     JOIN referencia rd ON rd.id = s.referencia_destino_id
     JOIN zona zo ON zo.id = ro.zona_id
     JOIN zona zd ON zd.id = rd.zona_id
     WHERE pd.emisor = 'cliente'
       AND pd.creado_en >= now() - make_interval(days => $3)
       AND COALESCE(zo.zona_padre_id, zo.id) = $1
       AND COALESCE(zd.zona_padre_id, zd.id) = $2`,
    [origen, destino, ventanaDias],
  );
  const importes = precios.rows.map((f: { importe_xaf: string }) => Number(f.importe_xaf));
  if (importes.length < minimas) return null;

  const banda = bandaDeLosPrecios(importes);
  if (banda === null) return null;
  await cliente.query(
    `INSERT INTO banda_precio (zona_origen_id, zona_destino_id, p25, p50, p75, muestras)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (zona_origen_id, zona_destino_id)
       DO UPDATE SET p25 = EXCLUDED.p25, p50 = EXCLUDED.p50, p75 = EXCLUDED.p75,
                     muestras = EXCLUDED.muestras, actualizada_en = now()`,
    [origen, destino, banda.p25, banda.p50, banda.p75, banda.muestras],
  );
  return banda;
}

export interface SenalDeTarifa {
  conductorId: number;
  nombre: string;
  marcas: number;
  porEncimaDelP75: number;
  viajes: number;
}

// Vigilancia de tarifa (R5, P12-02). Dos señales, y la primera es la que vale:
//
//   - `marcas`: veces que un pasajero marcó «me cobró de más» en la ventana.
//     No necesita ninguna cifra y es una acusación explícita.
//   - `porEncimaDelP75`: viajes cuyo precio declarado quedó por encima del p75
//     de su ruta. Un viaje así no dice nada —una noche, lluvia, maletas—; lo
//     que dice algo es que sean casi todos.
//
// Devuelve solo a quien pasa del umbral de marcas, y con los dos números
// delante: el operador decide, no esto.
export async function senalesDeTarifa(
  cliente: pg.ClientBase | pg.Pool,
  dias = 30,
): Promise<SenalDeTarifa[]> {
  const minimo = await leerParametroEntero(cliente, 'alarma_cobros_de_mas');
  const res = await cliente.query(
    `WITH viajes AS (
       SELECT v.id, v.conductor_id, c.nombre,
              COALESCE(zo.zona_padre_id, zo.id) AS origen,
              COALESCE(zd.zona_padre_id, zd.id) AS destino
       FROM viaje v
       JOIN conductor c ON c.id = v.conductor_id
       JOIN solicitud s ON s.id = v.solicitud_id
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       JOIN zona zo ON zo.id = ro.zona_id
       JOIN zona zd ON zd.id = rd.zona_id
       WHERE v.creado_en >= now() - make_interval(days => $1)
     )
     SELECT vi.conductor_id, vi.nombre,
            count(*) FILTER (WHERE val.cobro_de_mas)::int AS marcas,
            count(*) FILTER (
              WHERE pd.importe_xaf IS NOT NULL AND b.p75 IS NOT NULL
                AND pd.importe_xaf > b.p75
            )::int AS por_encima,
            count(DISTINCT vi.id)::int AS viajes
     FROM viajes vi
     LEFT JOIN valoracion val ON val.viaje_id = vi.id AND val.emisor = 'cliente'
     LEFT JOIN precio_declarado pd ON pd.viaje_id = vi.id AND pd.emisor = 'cliente'
     LEFT JOIN banda_precio b
       ON b.zona_origen_id = vi.origen AND b.zona_destino_id = vi.destino
     GROUP BY vi.conductor_id, vi.nombre
     HAVING count(*) FILTER (WHERE val.cobro_de_mas) >= $2
     ORDER BY marcas DESC, por_encima DESC`,
    [dias, minimo],
  );
  return res.rows.map((f: {
    conductor_id: string; nombre: string; marcas: number; por_encima: number; viajes: number;
  }) => ({
    conductorId: Number(f.conductor_id),
    nombre: f.nombre,
    marcas: f.marcas,
    porEncimaDelP75: f.por_encima,
    viajes: f.viajes,
  }));
}
