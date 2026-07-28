// Utilidad de una vez: borra referencias que quedaron mal asignadas a zonas
// «Zona Prueba <uuid>» dejadas por la batería de pruebas en la base de
// desarrollo compartida. No es parte del flujo normal.
import { crearPool } from '../src/bd/conexion.js';
import { NOMBRES_ZONAS_REALES } from './barrios-malabo-datos.js';
import { POIS } from './pois-reales-datos.js';

// Solo las filas que el propio importar-pois-reales.ts creó por error bajo una
// zona de prueba (identificadas por nombre exacto), nunca todo lo que haya en
// esas zonas: otras pruebas pueden tener solicitudes reales apuntando ahí.
async function main() {
  const pool = crearPool();
  const nombres = POIS.map((p) => p.n);
  const ZONAS_REALES = NOMBRES_ZONAS_REALES;
  const r = await pool.query(
    `DELETE FROM referencia
     WHERE nombre = ANY($1)
       AND zona_id NOT IN (SELECT id FROM zona WHERE nombre = ANY($2))
       AND id NOT IN (SELECT DISTINCT referencia_origen_id FROM solicitud WHERE referencia_origen_id IS NOT NULL)
       AND id NOT IN (SELECT DISTINCT referencia_destino_id FROM solicitud WHERE referencia_destino_id IS NOT NULL)`,
    [nombres, ZONAS_REALES],
  );
  console.log('borradas', r.rowCount);
  await pool.end();
}

void main();
