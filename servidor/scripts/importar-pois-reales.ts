// Importa el catálogo real de sitios de Malabo (90 lugares, recorte OSM
// bbox=8.765,3.745,8.795,3.780) al gazetteer. Complementa, no sustituye, la
// semilla de prueba de datos-prueba.ts: usa la misma clave natural
// (zona, nombre), así que se puede ejecutar tantas veces como haga falta.
//
// «Puerto de Bata» se descarta a propósito: sus coordenadas caen fuera del
// recuadro de Malabo (es el puerto de otra ciudad, en el continente, fuera
// del área que cubre este servicio de taxi).
//
// Uso: tsx scripts/importar-pois-reales.ts

import pg from 'pg';
import { urlBaseDatos } from '../src/bd/migrar.js';
import { NOMBRES_ZONAS_REALES } from './barrios-malabo-datos.js';
import { POIS } from './pois-reales-datos.js';

const CATEGORIA_POR_TIPO: Record<string, string> = {
  hotel: 'hotel',
  market: 'mercado',
  food: 'restaurante',
  bank: 'banco',
  fuel: 'gasolinera',
  area: 'zona',
  gov: 'gobierno',
  church: 'iglesia',
  transport: 'transporte',
  hospital: 'hospital',
  pharmacy: 'farmacia',
  plaza: 'plaza',
  school: 'escuela',
};

async function main() {
  const pool = new pg.Pool({ connectionString: urlBaseDatos() });
  // Solo las zonas reales, por nombre exacto: la base de desarrollo acumula
  // miles de zonas efímeras de la batería de pruebas («Zona A <uuid>», «Zona
  // Prueba <uuid>»…) que no son destino válido para datos reales. Lista
  // blanca, no lista negra: los nombres de prueba no siguen un único patrón.
  const zonas = (await pool.query(
    'SELECT id, nombre, centroide_lat AS lat, centroide_lng AS lng FROM zona WHERE nombre = ANY($1)',
    [NOMBRES_ZONAS_REALES],
  )).rows as Array<{ id: number; nombre: string; lat: number; lng: number }>;
  if (zonas.length === 0) {
    throw new Error(
      'No hay zonas reales en la base de datos. Ejecuta antes npm run bd:barrios.',
    );
  }

  function zonaMasCercana(lat: number, lng: number) {
    let mejor = zonas[0];
    let mejorDistancia = Infinity;
    for (const z of zonas) {
      const d = (z.lat - lat) ** 2 + (z.lng - lng) ** 2;
      if (d < mejorDistancia) {
        mejorDistancia = d;
        mejor = z;
      }
    }
    return mejor;
  }

  let creadas = 0;
  let actualizadas = 0;
  let descartadas = 0;
  let apagadas = 0;
  for (const poi of POIS) {
    const [lng, lat] = poi.p;
    // Fuera del recuadro de Malabo (bbox 8.765,3.745,8.795,3.780): dato real
    // pero de otra ciudad, no cubierto por este servicio.
    if (lng < 8.7 || lng > 8.9 || lat < 3.7 || lat > 3.85) {
      descartadas += 1;
      continue;
    }
    const categoria = CATEGORIA_POR_TIPO[poi.k] ?? 'otro';
    const zona = zonaMasCercana(lat, lng);

    // La clave natural de la tabla es (zona, nombre), pero la identidad de un
    // sitio es solo su NOMBRE: el Mercado Central sigue siendo el mismo aunque
    // al redibujar los barrios pase de «Malabo Centro» a «Los Ángeles». Si se
    // insertara sin más, saldría dos veces en el buscador y la copia nueva
    // empezaría con el contador de usos a cero, perdiendo el historial que
    // ordena los resultados. Por eso se busca primero y se MUEVE la fila.
    //
    // Si hay varias (de un import anterior que sí duplicó), gana la más usada:
    // es la que tiene historial de verdad y a la que apuntan los viajes.
    const existentes = await pool.query(
      `SELECT r.id, r.zona_id, r.veces_usada::int AS usos
       FROM referencia r JOIN zona z ON z.id = r.zona_id
       WHERE r.nombre = $1 AND z.nombre = ANY($2)
       ORDER BY r.veces_usada DESC, r.id`,
      [poi.n, NOMBRES_ZONAS_REALES],
    );

    if (existentes.rowCount === 0) {
      await pool.query(
        `INSERT INTO referencia (zona_id, nombre, lat, lng, categoria)
         VALUES ($1, $2, $3, $4, $5)`,
        [zona.id, poi.n, lat, lng, categoria],
      );
      creadas += 1;
    } else {
      const filas = existentes.rows as Array<{ id: number; zona_id: number; usos: number }>;
      // Si ya hay una fila en la zona destino, esa es la que se queda: el
      // índice único (zona, nombre) impide mover otra encima de ella. Si no,
      // se queda la más usada y se mueve.
      const superviviente = filas.find((f) => String(f.zona_id) === String(zona.id)) ?? filas[0];
      // El contador de usos ordena los resultados del buscador. Al fundir
      // copias se conserva el mayor, o el sitio caería al final de la lista
      // justo por haberlo reorganizado.
      const usos = Math.max(...filas.map((f) => f.usos));
      await pool.query(
        `UPDATE referencia
         SET zona_id = $2, lat = $3, lng = $4, categoria = $5, activa = true, veces_usada = $6
         WHERE id = $1`,
        [superviviente.id, zona.id, lat, lng, categoria, usos],
      );
      actualizadas += 1;

      // Las copias sobrantes se apagan, no se borran aquí: puede haber viajes
      // que apunten a ellas. El repaso final se lleva las que no.
      const sobrantes = await pool.query(
        `UPDATE referencia SET activa = false
         WHERE nombre = $1 AND id <> $2 AND activa
           AND zona_id IN (SELECT id FROM zona WHERE nombre = ANY($3))`,
        [poi.n, superviviente.id, NOMBRES_ZONAS_REALES],
      );
      apagadas += sobrantes.rowCount ?? 0;
    }
  }

  // Las que quedaron apagadas y no las usa ningún viaje ya no le sirven a
  // nadie: fuera, para que el catálogo no acumule basura.
  const borradas = await pool.query(
    `DELETE FROM referencia r
     WHERE r.nombre = ANY($1) AND NOT r.activa
       AND NOT EXISTS (SELECT 1 FROM solicitud s WHERE s.referencia_origen_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM solicitud s WHERE s.referencia_destino_id = r.id)`,
    [POIS.map((p) => p.n)],
  );

  console.log(`Sitios reales importados: ${creadas} creados, ${actualizadas} actualizados, ${descartadas} descartados (fuera de Malabo).`);
  if (apagadas > 0 || (borradas.rowCount ?? 0) > 0) {
    console.log(`Duplicados de otra zona: ${apagadas} apagados, ${borradas.rowCount} borrados.`);
  }
  await pool.end();
}

void main();
