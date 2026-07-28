// Verificación de un conductor dado de alta por su cuenta.
//
// Quien se registra desde la app queda en 'pendiente' y NO recibe carreras
// hasta que alguien comprueba sus datos. Esa comprobación es trabajo del
// operador (paso 9, con su pantalla); hasta entonces se hace con esta orden.
//
// Uso:
//   tsx scripts/verificar-conductor.ts pendientes
//   tsx scripts/verificar-conductor.ts verificar <telefono>
//   tsx scripts/verificar-conductor.ts rechazar <telefono>

import { crearPool, enTransaccion } from '../src/bd/conexion.js';

async function principal(): Promise<void> {
  const [orden, telefono] = process.argv.slice(2);
  const pool = crearPool();
  try {
    if (orden === 'pendientes') {
      const res = await pool.query(
        `SELECT c.telefono, c.nombre, c.correo, c.estado_verificacion,
                v.matricula, v.marca, v.carroceria, v.plazas
         FROM conductor c LEFT JOIN vehiculo v ON v.conductor_id = c.id
         WHERE c.estado_verificacion <> 'verificado'
         ORDER BY c.fecha_alta DESC`,
      );
      if (res.rowCount === 0) {
        console.log('No hay conductores pendientes.');
      } else {
        console.table(res.rows);
      }
    } else if (orden === 'verificar' || orden === 'rechazar') {
      if (!telefono) throw new Error(`Uso: ${orden} <telefono>`);
      const nuevoEstado = orden === 'verificar' ? 'verificado' : 'rechazado';
      const res = await enTransaccion(pool, (c) => c.query(
        `UPDATE conductor SET estado_verificacion = $2 WHERE telefono = $1
         RETURNING nombre, estado_verificacion`,
        [telefono, nuevoEstado],
      ));
      if (res.rowCount === 0) {
        throw new Error(`No existe ningún conductor con teléfono ${telefono}.`);
      }
      console.log(`${res.rows[0].nombre}: ${res.rows[0].estado_verificacion}.`);
      if (nuevoEstado === 'verificado') {
        console.log('Ya puede entrar en servicio y recibir carreras (necesita suscripción vigente).');
      }
    } else {
      throw new Error('Órdenes: pendientes, verificar <telefono>, rechazar <telefono>');
    }
  } finally {
    await pool.end();
  }
}

principal().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
