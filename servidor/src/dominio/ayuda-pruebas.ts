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

// Ejecuta una prueba con el aviso a la ciudad entera APAGADO (migración 064).
//
// Es el mismo problema que arriba, un escalón más arriba: con el aviso
// encendido, el corte R1 mira toda la ciudad, así que basta un taxi vivo en
// cualquier barrio de la base compartida —y en la de desarrollo hay varios,
// dejados por otras pruebas— para que ninguna solicitud se cierre nunca con
// «no hay taxi». Eso es lo correcto en producción y hace imposible escribir
// aquí la prueba del corte.
//
// Quien prueba el corte por zona vacía está probando eso. La oleada 5 tiene
// sus propias pruebas, y precisamente comprueban lo contrario: que con el
// aviso encendido la carrera NO se cierra.
export async function sinAvisoALaCiudad<T>(
  pool: pg.Pool,
  prueba: () => Promise<T>,
): Promise<T> {
  const antes = await pool.query(
    `SELECT valor FROM parametro WHERE clave = 'aviso_ciudad_entera'`,
  );
  const valor = antes.rows[0]?.valor ?? '1';
  await pool.query(`UPDATE parametro SET valor = '0' WHERE clave = 'aviso_ciudad_entera'`);
  try {
    return await prueba();
  } finally {
    await pool.query(
      `UPDATE parametro SET valor = $1 WHERE clave = 'aviso_ciudad_entera'`, [valor],
    );
  }
}
