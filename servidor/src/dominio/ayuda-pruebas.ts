// Ayudas para las pruebas. No lo usa el servidor: lo usan las baterías.
//
// Vive aquí y no dentro de un `.prueba.ts` porque hace falta en tres ficheros
// distintos, y tres copias de lo mismo se separan a la primera corrección.

import type pg from 'pg';

// Ejecuta una prueba con NINGÚN taxista de «toda la isla» en la base.
//
// Un taxista con esa marca (migración 048) es global por definición: le alcanza
// cualquier solicitud, y desde el arreglo del corte R1 (21/09) su sola
// presencia impide que una solicitud se cierre con «no hay taxi» — que es lo
// correcto en producción, porque esa carrera sí tiene a quién ir.
//
// El efecto secundario es que ninguna prueba del corte R1 se puede escribir en
// una base compartida donde alguien tenga esa marca puesta a mano: en la de
// desarrollo la tiene el taxi del operador, y después de unificarlo, su
// taxista de verdad. Esto la quita mientras dura la prueba y la devuelve al
// terminar, gane o falle.
//
// No maquilla el escenario: acota lo que la prueba mide. Quien prueba el corte
// por zona vacía está probando eso, no la oleada de toda la isla, que tiene
// sus propias pruebas.
export async function sinTaxisDeTodaLaIsla<T>(
  pool: pg.Pool,
  prueba: () => Promise<T>,
): Promise<T> {
  const marcados = await pool.query(
    'SELECT id FROM conductor WHERE recibe_en_cualquier_zona',
  );
  const ids = marcados.rows.map((f) => f.id);
  if (ids.length > 0) {
    await pool.query(
      'UPDATE conductor SET recibe_en_cualquier_zona = false WHERE id = ANY($1)', [ids],
    );
  }
  try {
    return await prueba();
  } finally {
    if (ids.length > 0) {
      await pool.query(
        'UPDATE conductor SET recibe_en_cualquier_zona = true WHERE id = ANY($1)', [ids],
      );
    }
  }
}
