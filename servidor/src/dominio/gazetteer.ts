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

// Un barrio que todavía no tiene entrada en el catálogo (28/09). Sale
// del buscador como cualquier otro resultado, pero sin `id`: para poder pedir
// un taxi hay que darle su entrada primero, y eso es una escritura que no se
// hace en una búsqueda.
export interface ZonaEncontrada {
  zonaId: number;
  nombre: string;
  lat: number;
  lng: number;
  similitud: number;
}

// Los barrios que se parecen a lo que se escribió y todavía no están en el
// catálogo. Los que ya tienen entrada no salen por aquí: salen por la búsqueda
// normal, que es donde les toca.
//
// Solo barrios SITUADOS: sin coordenadas no se puede mandar un taxi a un
// nombre, y ofrecerlo sería prometer algo que no se puede cumplir.
export async function buscarZonas(
  cliente: Lector,
  texto: string,
  limite = 3,
): Promise<ZonaEncontrada[]> {
  const consulta = texto.trim();
  if (consulta.length < 2) return [];
  const res = await cliente.query(
    `SELECT z.id, z.nombre, z.centroide_lat AS lat, z.centroide_lng AS lng,
            similarity(z.nombre, $1) AS similitud
     FROM zona z
     WHERE z.referencia_id IS NULL
       AND z.centroide_lat IS NOT NULL AND z.centroide_lng IS NOT NULL
       AND z.nombre % $1
     ORDER BY similarity(z.nombre, $1) DESC, z.nombre
     LIMIT $2`,
    [consulta, limite],
  );
  return res.rows.map((f: {
    id: string; nombre: string; lat: string; lng: string; similitud: string;
  }) => ({
    zonaId: Number(f.id),
    nombre: f.nombre,
    lat: Number(f.lat),
    lng: Number(f.lng),
    similitud: Number(f.similitud),
  }));
}

// La entrada del catálogo de un barrio, creándola si no la tenía.
//
// Es la convención de la migración 038: misma zona, mismo nombre, categoría
// «zona», en el centro del barrio. Idempotente: dos personas buscando el mismo
// barrio a la vez acaban con la misma entrada, no con dos.
export async function entradaDeZona(
  cliente: pg.ClientBase,
  zonaId: number,
): Promise<{ referenciaId: number; nombre: string; lat: number; lng: number } | null> {
  const zona = await cliente.query(
    `SELECT id, nombre, centroide_lat, centroide_lng, referencia_id
     FROM zona WHERE id = $1`,
    [zonaId],
  );
  if (zona.rowCount === 0) return null;
  const z = zona.rows[0];
  if (z.centroide_lat === null || z.centroide_lng === null) return null;

  if (z.referencia_id !== null) {
    const ya = await cliente.query(
      'SELECT id, nombre, lat, lng FROM referencia WHERE id = $1',
      [z.referencia_id],
    );
    if (ya.rowCount === 1) {
      return {
        referenciaId: Number(ya.rows[0].id),
        nombre: ya.rows[0].nombre,
        lat: Number(ya.rows[0].lat),
        lng: Number(ya.rows[0].lng),
      };
    }
  }

  const creada = await cliente.query(
    `INSERT INTO referencia (zona_id, nombre, lat, lng, categoria)
     VALUES ($1, $2, $3, $4, 'zona')
     ON CONFLICT (zona_id, nombre) DO UPDATE SET activa = true
     RETURNING id, nombre, lat, lng`,
    [z.id, z.nombre, Number(z.centroide_lat), Number(z.centroide_lng)],
  );
  await cliente.query('UPDATE zona SET referencia_id = $2 WHERE id = $1', [z.id, creada.rows[0].id]);
  return {
    referenciaId: Number(creada.rows[0].id),
    nombre: creada.rows[0].nombre,
    lat: Number(creada.rows[0].lat),
    lng: Number(creada.rows[0].lng),
  };
}

export interface OpcionesBusqueda {
  // Quién busca. Sirve para una sola cosa: que quien propuso un sitio lo
  // encuentre desde el primer momento aunque todavía no esté aprobado
  // (migración 072).
  dispositivoId?: number;
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
       -- Un sitio propuesto y todavía sin aprobar (migración 072) solo lo ve
       -- quien lo puso: es su viaje y no puede esperar, pero el buscador de
       -- los demás no se llena de nombres que nadie ha confirmado.
       AND (r.propuesta_en IS NULL OR r.aprobada_en IS NOT NULL
            OR r.propuesta_por_dispositivo_id = $4)
       AND (r.nombre % $1 OR EXISTS (
              SELECT 1 FROM referencia_alias a2
              WHERE a2.referencia_id = r.id AND a2.alias % $1))
     GROUP BY r.id, z.nombre
     ORDER BY round(GREATEST(similarity(r.nombre, $1),
                             COALESCE(MAX(similarity(a.alias, $1)), 0))::numeric, 1) DESC,
              r.veces_usada DESC,
              similitud DESC
     LIMIT $3`,
    [consulta, opciones.zonaId ?? null, limite, opciones.dispositivoId ?? null],
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
  categoria?: string;
  // Metros de radio que declaró el teléfono (migración 038). `null` no es lo
  // mismo que no mandarlo: null dice «se puso a mano, sin verificar sobre el
  // terreno» y BORRA la precisión que hubiera —porque las coordenadas que
  // acompañan son otras—, mientras que omitir la clave deja lo que hubiera.
  precisionM?: number | null;
}

export async function editarReferencia(
  cliente: pg.ClientBase,
  referenciaId: number,
  cambios: CambiosReferencia,
): Promise<void> {
  const res = await cliente.query(
    // La precisión va aparte del resto: los demás campos usan COALESCE, que
    // no distingue «no lo mandes» de «ponlo a null», y aquí esa diferencia
    // es justo la que dice si el sitio se verificó sobre el terreno.
    `UPDATE referencia
     SET nombre = COALESCE($2, nombre),
         zona_id = COALESCE($3, zona_id),
         lat = COALESCE($4, lat),
         lng = COALESCE($5, lng),
         activa = COALESCE($6, activa),
         categoria = COALESCE($7, categoria),
         precision_gps_m = CASE WHEN $8 THEN $9 ELSE precision_gps_m END
     WHERE id = $1`,
    [
      referenciaId,
      cambios.nombre ?? null,
      cambios.zonaId ?? null,
      cambios.lat ?? null,
      cambios.lng ?? null,
      cambios.activa ?? null,
      cambios.categoria ?? null,
      'precisionM' in cambios,
      cambios.precisionM ?? null,
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
