// Lectura de parámetros operativos (tabla parametro). Las constantes de
// negocio viven en la base de datos, no en el código (sección 10).

import type pg from 'pg';

// Acepta pool o cliente en transacción: los parámetros son de solo lectura y
// no necesitan participar en la transacción de quien los consulta.
export async function leerParametroEntero(
  cliente: pg.ClientBase | pg.Pool,
  clave: string,
): Promise<number> {
  const res = await cliente.query('SELECT valor FROM parametro WHERE clave = $1', [clave]);
  if (res.rowCount === 0) {
    throw new Error(`No existe el parámetro «${clave}» en la tabla parametro.`);
  }
  const valor = Number.parseInt(res.rows[0].valor, 10);
  if (!Number.isInteger(valor)) {
    throw new Error(`El parámetro «${clave}» no es un entero: «${res.rows[0].valor}».`);
  }
  return valor;
}
