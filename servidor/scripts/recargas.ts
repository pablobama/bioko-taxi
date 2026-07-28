// Gestión de las recargas del monedero por parte del operador.
//
// AVISO: confirmar una recarga SUBE EL SALDO de verdad. El sistema no
// comprueba ningún pago — no hay integración con Muni Dinero ni con nadie.
// Antes de confirmar hay que MIRAR la cuenta de Muni Dinero (o tener el
// efectivo en la mano) y comprobar que el importe y la referencia coinciden.
// Confirmar sin haber visto el dinero es regalar saldo.
//
// Uso:
//   tsx scripts/recargas.ts pendientes
//   tsx scripts/recargas.ts confirmar <REFERENCIA> <quien>
//   tsx scripts/recargas.ts rechazar <REFERENCIA> <quien> "<motivo>"
//   tsx scripts/recargas.ts caducar

import { crearPool, enTransaccion } from '../src/bd/conexion.js';
import { caducarRecargas, confirmarRecarga, rechazarRecarga } from '../src/dominio/recargas.js';

async function principal(): Promise<void> {
  const [orden, referencia, quien, motivo] = process.argv.slice(2);
  const pool = crearPool();
  try {
    if (orden === 'pendientes') {
      const res = await pool.query(
        `SELECT r.referencia, r.importe_xaf AS importe, r.metodo,
                c.nombre, c.telefono,
                to_char(r.solicitada_en, 'DD/MM HH24:MI') AS pedida,
                round(extract(epoch from (now() - r.solicitada_en)) / 3600)::int AS horas
         FROM recarga r JOIN conductor c ON c.id = r.conductor_id
         WHERE r.estado = 'pendiente'
         ORDER BY r.solicitada_en`,
      );
      if (res.rowCount === 0) {
        console.log('No hay recargas pendientes.');
      } else {
        console.table(res.rows);
        console.log('\nAntes de confirmar: comprueba el ingreso en Muni Dinero');
        console.log('(o que tienes el efectivo) y que coincide importe y referencia.');
      }
    } else if (orden === 'confirmar') {
      if (!referencia || !quien) {
        throw new Error('Uso: confirmar <REFERENCIA> <quien confirma>');
      }
      const resultado = await enTransaccion(pool, (c) => confirmarRecarga(c, referencia, quien));
      console.log(resultado.yaEstaba
        ? `La recarga ${referencia} ya estaba confirmada. Saldo: ${resultado.saldoXaf} XAF.`
        : `Confirmada: +${resultado.importeXaf} XAF. Saldo ahora: ${resultado.saldoXaf} XAF.`);
    } else if (orden === 'rechazar') {
      if (!referencia || !quien || !motivo) {
        throw new Error('Uso: rechazar <REFERENCIA> <quien> "<motivo>"');
      }
      await enTransaccion(pool, (c) => rechazarRecarga(c, referencia, quien, motivo));
      console.log(`Recarga ${referencia} rechazada: ${motivo}`);
    } else if (orden === 'caducar') {
      const cuantas = await enTransaccion(pool, (c) => caducarRecargas(c));
      console.log(`${cuantas} recargas pendientes marcadas como caducadas.`);
    } else {
      throw new Error('Órdenes: pendientes, confirmar, rechazar, caducar');
    }
  } finally {
    await pool.end();
  }
}

principal().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
