// Consulta ad hoc contra la base de datos (no hay psql en los binarios
// embebidos). Uso: tsx scripts/consulta.ts "SELECT ..."

import pg from 'pg';
import { urlBaseDatos } from '../src/bd/migrar.js';

async function principal(): Promise<void> {
  const sql = process.argv[2];
  if (!sql) {
    throw new Error('Falta la consulta. Uso: tsx scripts/consulta.ts "SELECT ..."');
  }
  const cliente = new pg.Client({ connectionString: urlBaseDatos() });
  await cliente.connect();
  try {
    const resultado = await cliente.query(sql);
    const filas = Array.isArray(resultado) ? resultado.map((r) => r.rows).flat() : resultado.rows;
    console.table(filas);
  } finally {
    await cliente.end();
  }
}

principal().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
