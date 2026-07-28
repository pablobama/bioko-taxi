// Gazetteer (paso 4, sección 7): catálogo propio de referencias y zonas.
// Nada de geocodificación de terceros.
//
// Búsqueda: coincidencia difusa pg_trgm sobre nombre y alias. El orden es
// (1) similitud redondeada a décimas, (2) veces_usada, (3) similitud exacta:
// entre resultados de calidad parecida, lo más pedido sube.

import type pg from 'pg';
import { ErrorEntidadInexistente } from './errores.js';

// Las lecturas aceptan pool o cliente en transacción; las escrituras exigen
// cliente en transacción.
type Lector = pg.Pool | pg.ClientBase;

export interface ReferenciaEncontrada {
  id: number;
  nombre: string;
  zonaId: number;
  zona: string;
  lat: number;
  lng: number;
  categoria: string;
  vecesUsada: number;
  similitud: number;
  alias: string[];
}

export interface OpcionesBusqueda {
  zonaId?: number;
  limite?: number;
}

export async function buscarReferencias(
  cliente: Lector,
  texto: string,
  opciones: OpcionesBusqueda = {},
): Promise<ReferenciaEncontrada[]> {
  const consulta = texto.trim();
  if (consulta.length < 2) {
    throw new Error(`Texto de búsqueda demasiado corto: «${texto}». Mínimo 2 caracteres.`);
  }
  const limite = opciones.limite ?? 5;
  const res = await cliente.query(
    `SELECT r.id, r.nombre, r.zona_id, z.nombre AS zona, r.lat, r.lng, r.categoria, r.veces_usada,
            GREATEST(similarity(r.nombre, $1), COALESCE(MAX(similarity(a.alias, $1)), 0)) AS similitud,
            COALESCE(array_agg(a.alias) FILTER (WHERE a.alias IS NOT NULL), '{}') AS alias
     FROM referencia r
     JOIN zona z ON z.id = r.zona_id
     LEFT JOIN referencia_alias a ON a.referencia_id = r.id
     WHERE r.activa
       AND ($2::bigint IS NULL OR r.zona_id = $2)
       AND (r.nombre % $1 OR EXISTS (
              SELECT 1 FROM referencia_alias a2
              WHERE a2.referencia_id = r.id AND a2.alias % $1))
     GROUP BY r.id, z.nombre
     ORDER BY round(GREATEST(similarity(r.nombre, $1),
                             COALESCE(MAX(similarity(a.alias, $1)), 0))::numeric, 1) DESC,
              r.veces_usada DESC,
              similitud DESC
     LIMIT $3`,
    [consulta, opciones.zonaId ?? null, limite],
  );
  return res.rows.map(filaAReferencia);
}

// Respaldo de R1: si la búsqueda difusa no resuelve el origen, se ofrecen las
// referencias más usadas de la zona del cliente.
export async function referenciasMasUsadas(
  cliente: Lector,
  zonaId: number,
  limite = 5,
): Promise<ReferenciaEncontrada[]> {
  const res = await cliente.query(
    `SELECT r.id, r.nombre, r.zona_id, z.nombre AS zona, r.lat, r.lng, r.categoria, r.veces_usada,
            0 AS similitud,
            COALESCE(array_agg(a.alias) FILTER (WHERE a.alias IS NOT NULL), '{}') AS alias
     FROM referencia r
     JOIN zona z ON z.id = r.zona_id
     LEFT JOIN referencia_alias a ON a.referencia_id = r.id
     WHERE r.activa AND r.zona_id = $1
     GROUP BY r.id, z.nombre
     ORDER BY r.veces_usada DESC, r.nombre
     LIMIT $2`,
    [zonaId, limite],
  );
  return res.rows.map(filaAReferencia);
}

function filaAReferencia(fila: any): ReferenciaEncontrada {
  return {
    id: fila.id,
    nombre: fila.nombre,
    zonaId: fila.zona_id,
    zona: fila.zona,
    lat: fila.lat,
    lng: fila.lng,
    categoria: fila.categoria,
    vecesUsada: Number(fila.veces_usada),
    similitud: Number(fila.similitud),
    alias: fila.alias,
  };
}

export async function registrarUso(
  cliente: pg.ClientBase,
  referenciaId: number,
): Promise<number> {
  const res = await cliente.query(
    'UPDATE referencia SET veces_usada = veces_usada + 1 WHERE id = $1 RETURNING veces_usada',
    [referenciaId],
  );
  if (res.rowCount === 0) {
    throw new ErrorEntidadInexistente('la referencia', referenciaId);
  }
  return Number(res.rows[0].veces_usada);
}

// --- Administración (la usan la CLI de este paso y el panel del paso 9) ---

export async function crearZona(
  cliente: pg.ClientBase,
  nombre: string,
  lat?: number,
  lng?: number,
): Promise<{ zonaId: number; yaExistia: boolean }> {
  const insercion = await cliente.query(
    `INSERT INTO zona (nombre, centroide_lat, centroide_lng)
     VALUES ($1, $2, $3) ON CONFLICT (nombre) DO NOTHING RETURNING id`,
    [nombre, lat ?? null, lng ?? null],
  );
  if (insercion.rowCount === 1) {
    return { zonaId: insercion.rows[0].id, yaExistia: false };
  }
  const existente = await cliente.query('SELECT id FROM zona WHERE nombre = $1', [nombre]);
  return { zonaId: existente.rows[0].id, yaExistia: true };
}

export async function declararAdyacencia(
  cliente: pg.ClientBase,
  zonaIdA: number,
  zonaIdB: number,
): Promise<void> {
  await cliente.query(
    `INSERT INTO zona_adyacencia (zona_id, zona_adyacente_id)
     VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING`,
    [zonaIdA, zonaIdB],
  );
}

export interface DatosReferencia {
  zonaId: number;
  nombre: string;
  lat: number;
  lng: number;
  alias?: string[];
}

// Alta o actualización por clave natural (zona, nombre). Los alias nuevos se
// añaden; los existentes no se tocan (quitar un alias es acción explícita).
export async function guardarReferencia(
  cliente: pg.ClientBase,
  datos: DatosReferencia,
): Promise<{ referenciaId: number; creada: boolean }> {
  const insercion = await cliente.query(
    `INSERT INTO referencia (zona_id, nombre, lat, lng)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (zona_id, nombre)
       DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, activa = true
     RETURNING id, (xmax = 0) AS creada`,
    [datos.zonaId, datos.nombre, datos.lat, datos.lng],
  );
  const referenciaId: number = insercion.rows[0].id;
  for (const alias of datos.alias ?? []) {
    await cliente.query(
      `INSERT INTO referencia_alias (referencia_id, alias)
       VALUES ($1, $2) ON CONFLICT (referencia_id, alias) DO NOTHING`,
      [referenciaId, alias],
    );
  }
  return { referenciaId, creada: insercion.rows[0].creada };
}

export interface CambiosReferencia {
  nombre?: string;
  zonaId?: number;
  lat?: number;
  lng?: number;
  activa?: boolean;
}

export async function editarReferencia(
  cliente: pg.ClientBase,
  referenciaId: number,
  cambios: CambiosReferencia,
): Promise<void> {
  const res = await cliente.query(
    `UPDATE referencia
     SET nombre = COALESCE($2, nombre),
         zona_id = COALESCE($3, zona_id),
         lat = COALESCE($4, lat),
         lng = COALESCE($5, lng),
         activa = COALESCE($6, activa)
     WHERE id = $1`,
    [
      referenciaId,
      cambios.nombre ?? null,
      cambios.zonaId ?? null,
      cambios.lat ?? null,
      cambios.lng ?? null,
      cambios.activa ?? null,
    ],
  );
  if (res.rowCount === 0) {
    throw new ErrorEntidadInexistente('la referencia', referenciaId);
  }
}

export async function anadirAlias(
  cliente: pg.ClientBase,
  referenciaId: number,
  alias: string,
): Promise<void> {
  const existe = await cliente.query('SELECT 1 FROM referencia WHERE id = $1', [referenciaId]);
  if (existe.rowCount === 0) {
    throw new ErrorEntidadInexistente('la referencia', referenciaId);
  }
  await cliente.query(
    `INSERT INTO referencia_alias (referencia_id, alias)
     VALUES ($1, $2) ON CONFLICT (referencia_id, alias) DO NOTHING`,
    [referenciaId, alias],
  );
}

export async function quitarAlias(
  cliente: pg.ClientBase,
  referenciaId: number,
  alias: string,
): Promise<void> {
  const res = await cliente.query(
    'DELETE FROM referencia_alias WHERE referencia_id = $1 AND alias = $2',
    [referenciaId, alias],
  );
  if (res.rowCount === 0) {
    throw new Error(`La referencia ${referenciaId} no tiene el alias «${alias}».`);
  }
}
