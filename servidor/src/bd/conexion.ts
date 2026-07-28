// Pool de conexiones y ayudante de transacción. Todo acceso de escritura del
// dominio pasa por enTransaccion: o se confirma todo, o no se confirma nada.

import pg from 'pg';
import { urlBaseDatos } from './migrar.js';

export function crearPool(): pg.Pool {
  return new pg.Pool({ connectionString: urlBaseDatos() });
}

export async function enTransaccion<T>(
  pool: pg.Pool,
  funcion: (cliente: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await funcion(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    cliente.release();
  }
}
