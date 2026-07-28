// Simulador de conductor para desarrollo (la app Android real es el paso 8).
// Actúa sobre el dominio igual que lo hará la app: entrar en servicio,
// aceptar la oferta pendiente, confirmar salida, validar PIN y cerrar.
//
// Uso: tsx scripts/simular-conductor.ts <telefono> <orden> [argumentos]
//
//   conectar <zona>        entra en servicio en esa zona (UN heartbeat)
//   mantener <zona>        entra en servicio y RENUEVA el heartbeat cada 30 s,
//                          igual que hace el foreground service de la app.
//                          Déjalo corriendo mientras pruebas; Ctrl+C para salir.
//   ofertas                lista las ofertas pendientes del conductor
//   aceptar [solicitudId]  reclama la solicitud; sin argumento, la única
//                          oferta pendiente (lo cómodo para probar a mano)
//   salir <solicitudId>    confirma la salida (ACEPTADO → EN_CAMINO)
//   recoger <solicitudId> <pin>   valida el PIN (EN_CAMINO → RECOGIDO)
//   completar [solicitudId]  cierra el viaje (sin comisión ni precio)
//   suscribir                     cobra la cuota semanal del monedero
//   posicion <solicitudId> <lat> <lng>   registra una posición del conductor

import pg from 'pg';
import { crearPool, enTransaccion } from '../src/bd/conexion.js';
import { reclamarSolicitud } from '../src/dominio/despacho.js';
import { entrarEnServicio, registrarHeartbeat, salirDeServicio } from '../src/dominio/presencia.js';
import { renovarSuscripcion } from '../src/dominio/monedero.js';
import { estadoPorOcupacion } from '../src/dominio/ocupacion.js';
import { registrarPosicion } from '../src/dominio/proximidad.js';
import { transicionarConductor, transicionarSolicitud } from '../src/dominio/transiciones.js';
import { EmisorSalida } from '../src/eventos/bus.js';

async function conductorPorTelefono(pool: pg.Pool, telefono: string): Promise<number> {
  const res = await pool.query('SELECT id FROM conductor WHERE telefono = $1', [telefono]);
  if (res.rowCount === 0) {
    throw new Error(`No existe conductor con teléfono ${telefono}. Mira la semilla o el panel.`);
  }
  return res.rows[0].id;
}

// Resuelve el identificador de solicitud: el que se pasa por argumento o, si
// no hay ninguno, la única oferta/viaje pendiente del conductor. Evita tener
// que copiar números a mano al probar.
async function solicitudDe(
  pool: pg.Pool,
  conductorId: number,
  argumento: string | undefined,
): Promise<number> {
  if (argumento !== undefined) {
    return Number(argumento);
  }
  const res = await pool.query(
    `SELECT s.id FROM solicitud s
     WHERE s.conductor_id = $1 AND s.estado IN ('ACEPTADO', 'EN_CAMINO', 'RECOGIDO')
     UNION
     SELECT o.solicitud_id FROM oferta o
     JOIN solicitud s2 ON s2.id = o.solicitud_id
     WHERE o.conductor_id = $1 AND o.resultado IS NULL AND s2.estado = 'EMITIDO'
     ORDER BY 1 DESC LIMIT 1`,
    [conductorId],
  );
  if (res.rowCount === 0) {
    throw new Error('Este conductor no tiene ninguna oferta ni viaje en curso.');
  }
  return res.rows[0].id;
}

async function principal(): Promise<void> {
  const [telefono, orden, ...args] = process.argv.slice(2);
  if (!telefono || !orden) {
    throw new Error('Uso: simular-conductor <telefono> <conectar|ofertas|aceptar|salir|recoger|completar> …');
  }
  const pool = crearPool();
  const emisor = new EmisorSalida();
  try {
    const conductorId = await conductorPorTelefono(pool, telefono);

    if (orden === 'conectar') {
      if (!args[0]) throw new Error('Uso: conectar <zona>');
      const zona = await pool.query('SELECT id FROM zona WHERE nombre = $1', [args[0]]);
      if (zona.rowCount === 0) throw new Error(`No existe la zona «${args[0]}».`);
      await enTransaccion(pool, async (c) => {
        const presencia = await c.query('SELECT estado FROM presencia WHERE conductor_id = $1', [conductorId]);
        if (presencia.rows[0]?.estado === 'DESCONECTADO') {
          await entrarEnServicio(c, conductorId, zona.rows[0].id);
        } else {
          await registrarHeartbeat(c, conductorId, zona.rows[0].id);
        }
      });
      console.log(`Conductor ${telefono} en servicio en «${args[0]}» con heartbeat vivo.`);
    } else if (orden === 'mantener') {
      if (!args[0]) throw new Error('Uso: mantener <zona>');
      const zona = await pool.query('SELECT id FROM zona WHERE nombre = $1', [args[0]]);
      if (zona.rowCount === 0) throw new Error(`No existe la zona «${args[0]}».`);
      const zonaId: number = zona.rows[0].id;

      // Bucle equivalente al foreground service de la app (cada 30 s frente a
      // la ventana de 120 s del servidor: sobra margen para perder alguno).
      const latir = async (): Promise<void> => {
        await enTransaccion(pool, async (c) => {
          const presencia = await c.query('SELECT estado FROM presencia WHERE conductor_id = $1', [conductorId]);
          if (presencia.rows[0]?.estado === 'DESCONECTADO') {
            await entrarEnServicio(c, conductorId, zonaId);
          } else {
            await registrarHeartbeat(c, conductorId, zonaId);
          }
        });
        const estado = await pool.query('SELECT estado FROM presencia WHERE conductor_id = $1', [conductorId]);
        const ofertas = await pool.query(
          `SELECT o.solicitud_id, ro.nombre AS origen, rd.nombre AS destino
           FROM oferta o
           JOIN solicitud s ON s.id = o.solicitud_id
           JOIN referencia ro ON ro.id = s.referencia_origen_id
           JOIN referencia rd ON rd.id = s.referencia_destino_id
           WHERE o.conductor_id = $1 AND o.resultado IS NULL AND s.estado = 'EMITIDO'`,
          [conductorId],
        );
        const hora = new Date().toLocaleTimeString('es-ES');
        const aviso = ofertas.rowCount === 0
          ? ''
          : ofertas.rows
            .map((o) => `  ← OFERTA ${o.solicitud_id}: ${o.origen} → ${o.destino}`)
            .join('\n');
        console.log(`[${hora}] ${estado.rows[0].estado} en «${args[0]}»${aviso ? `\n${aviso}` : ''}`);
      };

      await latir();
      console.log('En servicio. Renovando cada 30 s — deja esta ventana abierta. Ctrl+C para salir.');
      const temporizador = setInterval(() => {
        latir().catch((error) => console.error('Fallo al latir:', error.message));
      }, 30_000);
      // No cerramos el pool: el proceso vive hasta que lo interrumpas.
      await new Promise<void>((resolver) => {
        process.on('SIGINT', () => {
          clearInterval(temporizador);
          console.log('\nSaliendo de servicio…');
          resolver();
        });
      });
      await enTransaccion(pool, (c) => salirDeServicio(c, conductorId));
      console.log('DESCONECTADO.');
    } else if (orden === 'ofertas') {
      const res = await pool.query(
        `SELECT o.solicitud_id, o.oleada, ro.nombre AS origen, rd.nombre AS destino
         FROM oferta o
         JOIN solicitud s ON s.id = o.solicitud_id
         JOIN referencia ro ON ro.id = s.referencia_origen_id
         JOIN referencia rd ON rd.id = s.referencia_destino_id
         WHERE o.conductor_id = $1 AND o.resultado IS NULL`,
        [conductorId],
      );
      console.table(res.rows);
    } else if (orden === 'aceptar') {
      const solicitudId = await solicitudDe(pool, conductorId, args[0]);
      const resultado = await reclamarSolicitud(pool, emisor, solicitudId, conductorId);
      console.log(resultado.gano
        ? `Solicitud ${solicitudId} GANADA: viaje ${resultado.viajeId}.`
        : `Solicitud ${solicitudId} perdida: ${resultado.motivo}.`);
    } else if (orden === 'salir') {
      const solicitudId = await solicitudDe(pool, conductorId, args[0]);
      await enTransaccion(pool, (c) =>
        transicionarSolicitud(c, solicitudId, 'EN_CAMINO', 'conductor', 'simulador'));
      console.log(`Solicitud ${solicitudId}: salida confirmada, EN_CAMINO.`);
    } else if (orden === 'recoger') {
      // Confirmación manual; el PIN es opcional (si se pasa, debe coincidir).
      const solicitudId = await solicitudDe(pool, conductorId, args[0]);
      const pin = args[1];
      await enTransaccion(pool, async (c) => {
        const viaje = await c.query('SELECT pin FROM viaje WHERE solicitud_id = $1', [solicitudId]);
        if (pin !== undefined && viaje.rows[0]?.pin !== pin) {
          throw new Error('PIN incorrecto: pídele al pasajero que lo dicte de nuevo.');
        }
        await transicionarSolicitud(
          c, solicitudId, 'RECOGIDO', 'conductor',
          pin !== undefined ? 'pin_validado' : 'confirmacion_manual',
        );
        await c.query('UPDATE viaje SET validado_en = now() WHERE solicitud_id = $1', [solicitudId]);
      });
      console.log('Recogida confirmada: RECOGIDO.');
    } else if (orden === 'completar') {
      const solicitudId = await solicitudDe(pool, conductorId, args[0]);
      await enTransaccion(pool, async (c) => {
        await transicionarSolicitud(c, solicitudId, 'COMPLETADO', 'conductor', 'simulador');
        await c.query('UPDATE viaje SET completado_en = now() WHERE solicitud_id = $1', [solicitudId]);
        // Taxi compartido: solo hay transición si el coche estaba lleno. Si le
        // quedaban plazas ya era DISPONIBLE y no hay nada que mover.
        const presencia = await c.query(
          'SELECT estado FROM presencia WHERE conductor_id = $1 FOR UPDATE',
          [conductorId],
        );
        const objetivo = await estadoPorOcupacion(c, conductorId);
        if (presencia.rows[0]?.estado !== objetivo) {
          await transicionarConductor(c, conductorId, objetivo, 'conductor', 'viaje_cerrado');
        }
      });
      console.log(`Solicitud ${solicitudId} COMPLETADA (sin comisión ni precio), conductor DISPONIBLE.`);
    } else if (orden === 'suscribir') {
      const resultado = await enTransaccion(pool, (c) => renovarSuscripcion(c, conductorId));
      console.log(
        `Suscripción vigente hasta ${resultado.suscritoHasta.toISOString().slice(0, 10)} `
        + `(saldo ${resultado.saldoXaf} XAF).`,
      );
    } else if (orden === 'posicion' || orden === 'posicion-cliente') {
      // «posicion-cliente» simula la lectura que en producción envía la PWA:
      // útil en desarrollo, donde el navegador está a miles de km de Malabo.
      // Con dos argumentos son lat y lng, y la solicitud se deduce.
      const actor = orden === 'posicion' ? 'conductor' : 'cliente';
      const sinSolicitud = args.length === 2;
      const solicitudId = await solicitudDe(pool, conductorId, sinSolicitud ? undefined : args[0]);
      const lat = Number(sinSolicitud ? args[0] : args[1]);
      const lng = Number(sinSolicitud ? args[1] : args[2]);
      await enTransaccion(pool, async (c) => {
        const viaje = await c.query('SELECT id FROM viaje WHERE solicitud_id = $1', [solicitudId]);
        if (viaje.rowCount === 0) throw new Error(`La solicitud ${solicitudId} no tiene viaje.`);
        await registrarPosicion(c, viaje.rows[0].id, actor, lat, lng);
      });
      console.log(`Posición del ${actor} registrada en la solicitud ${solicitudId}.`);
    } else {
      throw new Error(`Orden desconocida: «${orden}».`);
    }
  } finally {
    await pool.end();
  }
}

principal().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
