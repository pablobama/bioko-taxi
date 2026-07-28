// Deja el sistema listo para una demostración en localhost: una pasajera y un
// taxista verificado, con saldo, suscrito y en servicio.
//
// Los uuid de dispositivo son fijos y reconocibles (1111… y 2222…) para poder
// abrir cada rol en su ventana con ?dispositivo=. Solo sirve en desarrollo.
//
// Uso: npx tsx scripts/preparar-demo.ts

import { crearPool, enTransaccion } from '../src/bd/conexion.js';
import { urlBaseDatos } from '../src/bd/migrar.js';
import { renovarSuscripcion } from '../src/dominio/monedero.js';
import { entrarEnServicio } from '../src/dominio/presencia.js';
import { confirmarRecarga, solicitarRecarga } from '../src/dominio/recargas.js';

const CLIENTE = '11111111-1111-4111-8111-111111111111';
const TAXI = '22222222-2222-4222-8222-222222222222';
const TELEFONO_TAXISTA = '+240222700700';

async function principal(): Promise<void> {
  if (!urlBaseDatos().includes('localhost')) {
    throw new Error('preparar-demo solo funciona contra una base en localhost.');
  }
  const pool = crearPool();
  let zonaElegida = '';
  try {
    await enTransaccion(pool, async (cliente) => {
      // --- Pasajera ---
      const dispositivoCliente = await cliente.query(
        `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES ($1, 'cliente')
         ON CONFLICT (uuid_persistente) DO UPDATE SET tipo = 'cliente'
         RETURNING id`,
        [CLIENTE],
      );
      await cliente.query(
        `INSERT INTO perfil_cliente (dispositivo_id, telefono, nombre)
         VALUES ($1, '+240222555777', 'Ana Bindang')
         ON CONFLICT (dispositivo_id) DO UPDATE
           SET telefono = EXCLUDED.telefono, nombre = EXCLUDED.nombre`,
        [dispositivoCliente.rows[0].id],
      );

      // --- Taxista, ya verificado ---
      const conductor = await cliente.query(
        `INSERT INTO conductor (telefono, nombre, correo, estado_verificacion)
         VALUES ($1, 'Pablo Ondo', 'pablo@ejemplo.gq', 'verificado')
         ON CONFLICT (telefono) DO UPDATE
           SET nombre = EXCLUDED.nombre, estado_verificacion = 'verificado'
         RETURNING id`,
        [TELEFONO_TAXISTA],
      );
      const conductorId: number = conductor.rows[0].id;

      // Sin ON CONFLICT: vehiculo no tiene índice único por conductor (un
      // conductor podría tener varios coches en el futuro).
      const vehiculo = await cliente.query(
        'SELECT id FROM vehiculo WHERE conductor_id = $1',
        [conductorId],
      );
      if ((vehiculo.rowCount ?? 0) > 0) {
        await cliente.query(
          `UPDATE vehiculo SET matricula = 'GE-7007-T', marca = 'Toyota Land Cruiser',
                               color = 'blanco', carroceria = '4x4', plazas = 4
           WHERE conductor_id = $1`,
          [conductorId],
        );
      } else {
        await cliente.query(
          `INSERT INTO vehiculo (conductor_id, matricula, marca, color, carroceria, plazas)
           VALUES ($1, 'GE-7007-T', 'Toyota Land Cruiser', 'blanco', '4x4', 4)`,
          [conductorId],
        );
      }
      await cliente.query(
        'INSERT INTO monedero (conductor_id) VALUES ($1) ON CONFLICT (conductor_id) DO NOTHING',
        [conductorId],
      );
      await cliente.query(
        `INSERT INTO presencia (conductor_id, estado) VALUES ($1, 'DESCONECTADO')
         ON CONFLICT (conductor_id) DO NOTHING`,
        [conductorId],
      );
      await cliente.query(
        `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id, ultimo_heartbeat)
         VALUES ($1, 'conductor', $2, now())
         ON CONFLICT (uuid_persistente) DO UPDATE
           SET tipo = 'conductor', conductor_id = EXCLUDED.conductor_id`,
        [TAXI, conductorId],
      );

      // Saldo por la vía real: recarga pedida y confirmada, no un apunte suelto.
      const saldo = await cliente.query(
        'SELECT saldo_xaf FROM saldo_monedero WHERE conductor_id = $1',
        [conductorId],
      );
      if (Number(saldo.rows[0]?.saldo_xaf ?? 0) < 3000) {
        const recarga = await solicitarRecarga(cliente, conductorId, 12_000, 'muni_dinero');
        await confirmarRecarga(cliente, recarga.referencia, 'preparar-demo');
      }

      const suscripcion = await cliente.query(
        'SELECT suscrito_hasta FROM conductor WHERE id = $1',
        [conductorId],
      );
      const hasta = suscripcion.rows[0].suscrito_hasta;
      if (hasta === null || new Date(hasta) <= new Date()) {
        await renovarSuscripcion(cliente, conductorId);
      }

      // En servicio EN LA MISMA ZONA en la que arranca la pasajera, para que
      // la carrera le llegue en la primera oleada y la demostración no se pase
      // minuto y medio en «buscando taxi».
      //
      // Se busca por el sitio, no por el nombre de la zona: desde que el
      // catálogo tiene los barrios de verdad, el Mercado Central cae en
      // «Barrio Chino» y no en «Malabo Centro», y fijar el nombre a mano
      // volvería a desincronizarse a la próxima que se redibujen los barrios.
      const zona = await cliente.query(
        `SELECT z.id, z.nombre FROM referencia r JOIN zona z ON z.id = r.zona_id
         WHERE r.nombre = 'Mercado Central' AND r.activa
         ORDER BY r.veces_usada DESC LIMIT 1`,
      );
      if (zona.rowCount === 0) {
        throw new Error(
          'No se encuentra el «Mercado Central» en el gazetteer: carga los datos '
          + '(npm run bd:semilla, npm run bd:barrios y npm run bd:pois-reales).',
        );
      }
      const presencia = await cliente.query(
        'SELECT estado, zona_id FROM presencia WHERE conductor_id = $1',
        [conductorId],
      );
      if (presencia.rows[0].estado === 'DESCONECTADO') {
        await entrarEnServicio(cliente, conductorId, zona.rows[0].id);
      } else if (String(presencia.rows[0].zona_id) !== String(zona.rows[0].id)) {
        // Ya estaba en servicio, pero en otra zona (de una demostración
        // anterior o de antes de cargar los barrios). Se le mueve: si no, la
        // carrera volvería a tardar en llegarle.
        await cliente.query(
          'UPDATE presencia SET zona_id = $2 WHERE conductor_id = $1',
          [conductorId, zona.rows[0].id],
        );
      }
      zonaElegida = zona.rows[0].nombre;
    });

    const estado = await pool.query(
      `SELECT c.nombre, c.estado_verificacion, p.estado, s.saldo_xaf,
              c.suscrito_hasta > now() AS suscrito
       FROM conductor c
       JOIN presencia p ON p.conductor_id = c.id
       JOIN saldo_monedero s ON s.conductor_id = c.id
       WHERE c.telefono = $1`,
      [TELEFONO_TAXISTA],
    );
    const t = estado.rows[0];
    // Un ordenador no tiene GPS, así que las ventanas llevan ?gps= para
    // fingirlo (solo funciona en localhost). Sin eso no se ve lo que más
    // importa: el coche acercándose y los minutos que faltan.
    const GPS_PASAJERA = '3.74880,8.78006'; // Mercado Central
    const GPS_TAXISTA = '3.76050,8.78300'; // ~1,5 km al norte

    const enlace = (puerto: number, uuid: string, gps: string) =>
      `http://localhost:${puerto}/?dispositivo=${uuid}&gps=${gps}`;

    console.log('Listo para la demostración.\n');
    console.log('Abre cada enlace en SU PROPIA ventana, una al lado de la otra:\n');
    console.log(`  Pasajera Ana Bindang  ${enlace(8080, CLIENTE, GPS_PASAJERA)}`);
    console.log(`  Taxista Pablo Ondo    ${enlace(8080, TAXI, GPS_TAXISTA)}`);
    console.log('\nCon el servidor de desarrollo (npm run dev en /pwa), con recarga');
    console.log('en caliente al tocar el diseño:\n');
    console.log(`  Pasajera              ${enlace(5173, CLIENTE, GPS_PASAJERA)}`);
    console.log(`  Taxista               ${enlace(5173, TAXI, GPS_TAXISTA)}`);
    console.log(`\nTaxista: ${t.estado} en «${zonaElegida}» (la zona donde arranca la`);
    console.log(`pasajera, para que la carrera le llegue en la primera oleada), `
      + `${t.estado_verificacion},`);
    console.log(`saldo ${t.saldo_xaf} XAF, suscripción ${t.suscrito ? 'al día' : 'caducada'}.`);
    console.log('\nMientras la ventana del taxista esté abierta manda su latido, que');
    console.log('es lo que lo mantiene en servicio y publica su posición. Para verlo');
    console.log('moverse, cambia su ?gps= y recarga.');
  } finally {
    await pool.end();
  }
}

principal().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
