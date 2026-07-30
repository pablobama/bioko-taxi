// Arranque del servidor (paso 7). Cablea todas las piezas:
// pool → emisor outbox → despachador de eventos (sse/noop/fcm) →
// planificador de despacho → API HTTP → estáticos de la PWA.
//
// Uso: npm run servir   (PUERTO y BD_URL opcionales por entorno)

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import estaticos from '@fastify/static';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { avanzarDespachos, iniciarDespacho } from '../dominio/despacho.js';
import { ErrorSaldoInsuficiente } from '../dominio/errores.js';
import { renovarSuscripcion } from '../dominio/monedero.js';
import { caducarPresencias } from '../dominio/presencia.js';
import { procesarProximidad } from '../dominio/proximidad.js';
import { AdaptadorFcm } from '../eventos/adaptador-fcm.js';
import { AdaptadorNoop } from '../eventos/adaptador-noop.js';
import { AdaptadorSse, ConexionesSse } from '../eventos/adaptador-sse.js';
import { DespachadorEventos, EmisorSalida, type Adaptador } from '../eventos/bus.js';
import { crearServidor } from './servidor.js';

// PORT es la variable estándar que asignan los hostings (Render, Railway…);
// PUERTO es la propia, para desarrollo local. Se acepta cualquiera de las dos.
const PUERTO = Number(process.env.PORT ?? process.env.PUERTO ?? 8080);
const RUTA_PWA = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'pwa', 'dist',
);

// Rescate: una solicitud puede quedarse en SOLICITADO si el proceso cayó
// entre crearla y despacharla. El planificador la recoge.
async function rescatarSolicitadas(
  pool: ReturnType<typeof crearPool>,
  emisor: EmisorSalida,
): Promise<void> {
  const huerfanas = await pool.query(
    `SELECT id FROM solicitud
     WHERE estado = 'SOLICITADO' AND creada_en < now() - interval '5 seconds'`,
  );
  for (const fila of huerfanas.rows) {
    await iniciarDespacho(pool, emisor, fila.id);
  }
}

// Renovación automática: al vencer la cuota se intenta cobrar la siguiente
// del saldo. Sin saldo, aviso D7 (como mucho uno al día) y el conductor deja
// de recibir broadcasts hasta recargar. A los 30 días sin renovar se deja de
// intentar (el conductor se dio de baja de facto).
async function renovarSuscripcionesCaducadas(
  pool: ReturnType<typeof crearPool>,
  emisor: EmisorSalida,
): Promise<void> {
  const vencidos = await pool.query(
    `SELECT id FROM conductor
     WHERE suscrito_hasta IS NOT NULL
       AND suscrito_hasta < now()
       AND suscrito_hasta > now() - interval '30 days'`,
  );
  for (const fila of vencidos.rows) {
    try {
      await enTransaccion(pool, async (cliente) => {
        const resultado = await renovarSuscripcion(cliente, fila.id);
        await emisor.emitir({
          tipo: 'D7_suscripcion',
          rol: 'conductor',
          conductorId: fila.id,
          datos: {
            resultado: 'renovada',
            suscritoHasta: resultado.suscritoHasta,
            saldoXaf: resultado.saldoXaf,
          },
        }, cliente);
      });
    } catch (error) {
      if (!(error instanceof ErrorSaldoInsuficiente)) {
        console.error(`Error renovando la suscripción del conductor ${fila.id}:`, error);
        continue;
      }
      const avisado = await pool.query(
        `SELECT 1 FROM evento_salida
         WHERE tipo = 'D7_suscripcion' AND conductor_id = $1
           AND creado_en > now() - interval '24 hours'`,
        [fila.id],
      );
      if (avisado.rowCount === 0) {
        await enTransaccion(pool, (cliente) => emisor.emitir({
          tipo: 'D7_suscripcion',
          rol: 'conductor',
          conductorId: fila.id,
          datos: { resultado: 'sin_saldo' },
        }, cliente));
      }
    }
  }
}

async function principal(): Promise<void> {
  const pool = crearPool();
  const emisor = new EmisorSalida();
  const conexionesSse = new ConexionesSse();

  const adaptadores = new Map<string, Adaptador>([
    ['sse', new AdaptadorSse(conexionesSse)],
    ['noop', new AdaptadorNoop()],
  ]);
  if (process.env.FCM_CREDENCIALES_RUTA) {
    adaptadores.set('fcm', new AdaptadorFcm());
    console.log('Adaptador FCM configurado.');
  } else {
    console.warn(
      'FCM_CREDENCIALES_RUTA no definida: el canal «fcm» no está registrado. '
      + 'Los eventos de conductor fallarán ruidosamente salvo que la tabla '
      + 'enrutamiento los desvíe a «noop».',
    );
  }

  const despachadorEventos = new DespachadorEventos(pool, adaptadores);

  const app = crearServidor(pool, emisor, conexionesSse);
  if (existsSync(RUTA_PWA)) {
    await app.register(estaticos, { root: RUTA_PWA });
    console.log(`Sirviendo la PWA desde ${RUTA_PWA}`);
  } else {
    console.warn(`No existe ${RUTA_PWA}: la PWA no se sirve (¿falta construirla?).`);
  }

  // El puerto se abre ANTES de arrancar nada de fondo. El hosting concluye que
  // el despliegue funcionó cuando puede hablar con el puerto; si primero se
  // pusieran a trabajar el despachador y el planificador —los dos contra una
  // base de datos remota que puede estar lenta— el sondeo esperaría por algo
  // que no tiene nada que ver con estar listo para atender.
  await app.listen({ port: PUERTO, host: '0.0.0.0' });
  // 0.0.0.0, no localhost: dentro de un contenedor la diferencia es justo la
  // que decide si el hosting alcanza el servicio o no.
  console.log(`Servidor escuchando en 0.0.0.0:${PUERTO}`);

  despachadorEventos.iniciar(2000);

  // Planificador del despacho: oleadas, expiraciones, presencias y rescate.
  setInterval(() => {
    void (async () => {
      try {
        await avanzarDespachos(pool, emisor);
        await procesarProximidad(pool, emisor);
        await enTransaccion(pool, (c) => caducarPresencias(c));
        await rescatarSolicitadas(pool, emisor);
        await renovarSuscripcionesCaducadas(pool, emisor);
      } catch (error) {
        console.error('Error del planificador:', error);
      }
    })();
  }, 5000);
}

principal().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
