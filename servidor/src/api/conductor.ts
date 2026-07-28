// API HTTP del conductor (paso 8). La consume la app Android.
//
// Identidad: el uuid persistente del dispositivo, vinculado a un conductor
// dado de alta por el operador. El registro no crea conductores: solo une
// dispositivo y conductor existente.
//
// Regla R3: el teléfono del cliente NO aparece en ofertas ni al aceptar;
// solo se entrega al confirmar la salida (ACEPTADO → EN_CAMINO).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { enTransaccion } from '../bd/conexion.js';
import { reclamarSolicitud, rechazarOferta } from '../dominio/despacho.js';
import { ErrorOfertaInvalida, ErrorSaldoInsuficiente, ErrorTransicionInvalida } from '../dominio/errores.js';
import { distanciaMetros } from '../dominio/geo.js';
import type { EmisorEventos } from '../dominio/eventos.js';
import {
  procesarClienteAusente, renovarSuscripcion, suscripcionVigente,
} from '../dominio/monedero.js';
import { estadoPorOcupacion, ocupacionDe, rutaDe } from '../dominio/ocupacion.js';
import { registrarPosicion } from '../dominio/proximidad.js';
import { recargasDe, solicitarRecarga } from '../dominio/recargas.js';
import { leerParametroEntero } from '../dominio/parametros.js';
import { entrarEnServicio, registrarHeartbeat, salirDeServicio } from '../dominio/presencia.js';
import { transicionarConductor, transicionarSolicitud } from '../dominio/transiciones.js';
import type { ConexionesSse } from '../eventos/adaptador-sse.js';

const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorHttp(codigo: number, mensaje: string): Error & { statusCode: number } {
  const error = new Error(mensaje) as Error & { statusCode: number };
  error.statusCode = codigo;
  return error;
}

interface SesionConductor {
  dispositivoId: number;
  conductorId: number;
}

export function registrarRutasConductor(
  app: FastifyInstance,
  pool: pg.Pool,
  emisor: EmisorEventos,
  conexionesSse: ConexionesSse,
): void {
  function uuidDesde(req: FastifyRequest): string {
    // El parámetro de consulta es para SSE: EventSource no permite cabeceras.
    const uuid = (req.headers['x-dispositivo'] as string | undefined)
      ?? (req.query as Record<string, string | undefined>).dispositivo;
    if (!uuid || !PATRON_UUID.test(uuid)) {
      throw errorHttp(400, 'Falta la cabecera x-dispositivo con un UUID válido.');
    }
    return uuid.toLowerCase();
  }

  async function sesionDesde(req: FastifyRequest): Promise<SesionConductor> {
    const uuid = uuidDesde(req);
    const res = await pool.query(
      `UPDATE dispositivo SET ultimo_heartbeat = now()
       WHERE uuid_persistente = $1 AND tipo = 'conductor' AND conductor_id IS NOT NULL
       RETURNING id, conductor_id`,
      [uuid],
    );
    if (res.rowCount === 0) {
      throw errorHttp(401, 'Dispositivo no registrado como conductor. Haz el registro primero.');
    }
    return { dispositivoId: res.rows[0].id, conductorId: res.rows[0].conductor_id };
  }

  // Comprueba que la solicitud es del conductor y está en el estado esperado.
  async function solicitudDelConductor(
    cliente: pg.ClientBase,
    solicitudId: number,
    conductorId: number,
    estadosEsperados: string[],
  ): Promise<{ estado: string; viajeId: number; dispositivoClienteId: number; telefonoCliente: string; llegadoEn: Date | null }> {
    const res = await cliente.query(
      `SELECT s.estado, s.telefono_cliente, s.dispositivo_cliente_id, v.id AS viaje_id, v.llegado_en
       FROM solicitud s JOIN viaje v ON v.solicitud_id = s.id
       WHERE s.id = $1 AND s.conductor_id = $2
       FOR UPDATE OF s`,
      [solicitudId, conductorId],
    );
    if (res.rowCount === 0) {
      throw errorHttp(404, `La solicitud ${solicitudId} no existe o no es tuya.`);
    }
    const fila = res.rows[0];
    if (!estadosEsperados.includes(fila.estado)) {
      throw errorHttp(409, `La solicitud ${solicitudId} está en ${fila.estado}; se esperaba ${estadosEsperados.join(' o ')}.`);
    }
    return {
      estado: fila.estado,
      viajeId: fila.viaje_id,
      dispositivoClienteId: fila.dispositivo_cliente_id,
      telefonoCliente: fila.telefono_cliente,
      llegadoEn: fila.llegado_en,
    };
  }

  // Deja la presencia coherente con las plazas ocupadas (taxi compartido). No
  // transiciona si ya está en el estado que le toca: DISPONIBLE → DISPONIBLE
  // no existe en la tabla, y no debería.
  async function ajustarPresencia(
    cliente: pg.ClientBase,
    conductorId: number,
    actor: 'conductor' | 'sistema',
    origenEvento: string,
  ): Promise<void> {
    const fila = await cliente.query(
      'SELECT estado FROM presencia WHERE conductor_id = $1 FOR UPDATE',
      [conductorId],
    );
    const objetivo = await estadoPorOcupacion(cliente, conductorId);
    if (fila.rows[0]?.estado !== objetivo) {
      await transicionarConductor(cliente, conductorId, objetivo, actor, origenEvento);
    }
  }

  // Reloj de espera del punto de recogida (R4). Se acorta si el conductor ya
  // lleva pasajeros dentro: no puede tenerlos parados 5 minutos.
  async function relojEsperaSeg(cliente: pg.ClientBase, conductorId: number): Promise<number> {
    const ocupacion = await ocupacionDe(cliente, conductorId);
    return ocupacion.aBordo > 0
      ? leerParametroEntero(cliente, 'reloj_espera_con_pasajeros_seg')
      : leerParametroEntero(cliente, 'reloj_espera_cliente_seg');
  }

  async function saldoDe(conductorId: number): Promise<number> {
    const res = await pool.query(
      'SELECT saldo_xaf FROM saldo_monedero WHERE conductor_id = $1',
      [conductorId],
    );
    return res.rowCount === 0 ? 0 : Number(res.rows[0].saldo_xaf);
  }

  // --- Registro y sesión --------------------------------------------------

  app.post('/api/conductor/registro', async (req) => {
    const uuid = uuidDesde(req);
    const cuerpo = req.body as { telefono?: string; fcmToken?: string };
    if (!cuerpo?.telefono) {
      throw errorHttp(400, 'Falta el teléfono del conductor.');
    }
    const conductor = await pool.query(
      'SELECT id, nombre, estado_verificacion FROM conductor WHERE telefono = $1',
      [cuerpo.telefono],
    );
    if (conductor.rowCount === 0) {
      throw errorHttp(404, 'Ese teléfono no está dado de alta como conductor. Pide el alta al operador.');
    }
    if (conductor.rows[0].estado_verificacion !== 'verificado') {
      throw errorHttp(403, `Tu alta está en estado «${conductor.rows[0].estado_verificacion}». Habla con el operador.`);
    }
    const conductorId: number = conductor.rows[0].id;

    return enTransaccion(pool, async (cliente) => {
      const existente = await cliente.query(
        'SELECT id, tipo, conductor_id FROM dispositivo WHERE uuid_persistente = $1 FOR UPDATE',
        [uuid],
      );
      if (existente.rowCount === 0) {
        await cliente.query(
          `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id, fcm_token, ultimo_heartbeat)
           VALUES ($1, 'conductor', $2, $3, now())`,
          [uuid, conductorId, cuerpo.fcmToken ?? null],
        );
      } else if (existente.rows[0].tipo !== 'conductor' || existente.rows[0].conductor_id !== conductorId) {
        throw errorHttp(409, 'Este dispositivo ya está registrado con otra identidad. Habla con el operador.');
      } else {
        await cliente.query(
          `UPDATE dispositivo SET fcm_token = COALESCE($2, fcm_token), ultimo_heartbeat = now()
           WHERE uuid_persistente = $1`,
          [uuid, cuerpo.fcmToken ?? null],
        );
      }

      // Monedero y presencia existen desde el alta; por robustez se crean si faltan.
      await cliente.query(
        'INSERT INTO monedero (conductor_id) VALUES ($1) ON CONFLICT (conductor_id) DO NOTHING',
        [conductorId],
      );
      await cliente.query(
        `INSERT INTO presencia (conductor_id, estado) VALUES ($1, 'DESCONECTADO')
         ON CONFLICT (conductor_id) DO NOTHING`,
        [conductorId],
      );

      // Con centroide: la aplicación del taxista ordena las zonas por cercanía
      // a donde está, para no obligarle a buscar la suya en una lista de
      // cuarenta y siete barrios mientras conduce.
      const zonas = await cliente.query(
        `SELECT id, nombre, centroide_lat AS lat, centroide_lng AS lng
         FROM zona WHERE centroide_lat IS NOT NULL ORDER BY nombre`,
      );
      const presencia = await cliente.query('SELECT estado FROM presencia WHERE conductor_id = $1', [conductorId]);
      const saldo = await cliente.query('SELECT saldo_xaf FROM saldo_monedero WHERE conductor_id = $1', [conductorId]);
      const suscripcion = await cliente.query('SELECT suscrito_hasta FROM conductor WHERE id = $1', [conductorId]);
      return {
        conductorId,
        nombre: conductor.rows[0].nombre,
        estado: presencia.rows[0].estado,
        saldoXaf: Number(saldo.rows[0].saldo_xaf),
        suscritoHasta: suscripcion.rows[0].suscrito_hasta,
        cuotaXaf: await leerParametroEntero(cliente, 'suscripcion_importe_xaf'),
        cuotaDias: await leerParametroEntero(cliente, 'suscripcion_dias'),
        zonas: zonas.rows.filter((z) => !String(z.nombre).startsWith('Zona ')),
      };
    });
  });

  // --- Recargas del monedero (migración 018) ------------------------------
  //
  // La app solo PIDE la recarga y enseña cómo pagar. El saldo no se mueve
  // hasta que el operador confirma que ha visto el dinero.

  app.get('/api/conductor/recargas', async (req) => {
    const sesion = await sesionDesde(req);
    const minimo = await leerParametroEntero(pool, 'recarga_minima_xaf');
    const numero = await pool.query(
      `SELECT valor FROM parametro WHERE clave = 'muni_dinero_numero'`,
    );
    const titular = await pool.query(
      `SELECT valor FROM parametro WHERE clave = 'muni_dinero_titular'`,
    );
    return {
      minimoXaf: minimo,
      muniDinero: { numero: numero.rows[0].valor, titular: titular.rows[0].valor },
      // Importes sugeridos: 1, 2, 4 y 8 semanas de suscripción.
      sugeridos: [minimo, minimo * 2, minimo * 4, minimo * 8],
      recargas: await recargasDe(pool, sesion.conductorId),
    };
  });

  app.post('/api/conductor/recargas', async (req) => {
    const sesion = await sesionDesde(req);
    const cuerpo = (req.body ?? {}) as { importeXaf?: number; metodo?: string };
    if (cuerpo.metodo !== 'muni_dinero' && cuerpo.metodo !== 'efectivo') {
      throw errorHttp(400, 'Elige cómo pagas: muni_dinero o efectivo.');
    }
    try {
      return await enTransaccion(pool, (cliente) => solicitarRecarga(
        cliente, sesion.conductorId, cuerpo.importeXaf as number, cuerpo.metodo as 'muni_dinero' | 'efectivo',
      ));
    } catch (error) {
      if (error instanceof Error && /recarga mínima|Importe no válido/.test(error.message)) {
        throw errorHttp(400, error.message);
      }
      throw error;
    }
  });

  // Renovación (o alta) de la suscripción contra el saldo del monedero.
  app.post('/api/conductor/suscripcion', async (req) => {
    const sesion = await sesionDesde(req);
    try {
      const resultado = await enTransaccion(pool, (c) => renovarSuscripcion(c, sesion.conductorId));
      return {
        suscritoHasta: resultado.suscritoHasta,
        saldoXaf: resultado.saldoXaf,
        repetido: resultado.yaExistia,
      };
    } catch (error) {
      if (error instanceof ErrorSaldoInsuficiente) {
        throw errorHttp(402, `${error.message} Recarga el monedero con el operador.`);
      }
      throw error;
    }
  });

  app.post('/api/conductor/servicio', async (req) => {
    const sesion = await sesionDesde(req);
    const cuerpo = req.body as { enServicio?: boolean; zonaId?: number };
    if (typeof cuerpo?.enServicio !== 'boolean') {
      throw errorHttp(400, 'Falta enServicio (true/false).');
    }
    try {
      await enTransaccion(pool, async (cliente) => {
        if (cuerpo.enServicio) {
          if (!cuerpo.zonaId) {
            throw errorHttp(400, 'Para entrar en servicio hace falta zonaId.');
          }
          await entrarEnServicio(cliente, sesion.conductorId, cuerpo.zonaId);
        } else {
          await salirDeServicio(cliente, sesion.conductorId);
        }
      });
    } catch (error) {
      if (error instanceof ErrorTransicionInvalida) {
        throw errorHttp(409, error.message);
      }
      throw error;
    }
    return { enServicio: cuerpo.enServicio };
  });

  app.post('/api/conductor/heartbeat', async (req) => {
    const sesion = await sesionDesde(req);
    const cuerpo = (req.body ?? {}) as { zonaId?: number; lat?: number; lng?: number };
    await enTransaccion(pool, async (cliente) => {
      await registrarHeartbeat(cliente, sesion.conductorId, cuerpo.zonaId);
      // GPS continuo (migración 011): la posición del conductor viaja en el
      // propio heartbeat y solo se guarda mientras hay viajes activos.
      //
      // Se registra en TODOS los viajes activos, no solo en el último: con
      // taxi compartido cada pasajero necesita posiciones frescas del coche
      // para que su recogida y su cierre automáticos funcionen.
      if (typeof cuerpo.lat === 'number' && typeof cuerpo.lng === 'number') {
        const viajes = await cliente.query(
          `SELECT v.id FROM solicitud s JOIN viaje v ON v.solicitud_id = s.id
           WHERE s.conductor_id = $1 AND s.estado IN ('ACEPTADO', 'EN_CAMINO', 'RECOGIDO')`,
          [sesion.conductorId],
        );
        for (const viaje of viajes.rows) {
          await registrarPosicion(cliente, viaje.id, 'conductor', cuerpo.lat, cuerpo.lng);
        }
      }
    });
    const presencia = await pool.query(
      'SELECT estado FROM presencia WHERE conductor_id = $1',
      [sesion.conductorId],
    );
    return {
      estado: presencia.rows[0].estado,
      saldoXaf: await saldoDe(sesion.conductorId),
      suscripcionVigente: await suscripcionVigente(pool, sesion.conductorId),
    };
  });

  // Conexión viva del panel web del taxista. Por aquí le llegan las carreras
  // en el instante en que se emiten, en lugar de esperar al siguiente sondeo.
  // La app Android no la usa: para ella está FCM, que además funciona con la
  // pantalla apagada.
  app.get('/api/conductor/eventos', async (req, reply) => {
    const sesion = await sesionDesde(req);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(`data: ${JSON.stringify({ tipo: 'conectado' })}\n\n`);

    const baja = conexionesSse.suscribir(sesion.dispositivoId, (carga) => {
      reply.raw.write(`data: ${carga}\n\n`);
    });
    const latido = setInterval(() => {
      reply.raw.write(': latido\n\n');
    }, 25_000);
    req.raw.on('close', () => {
      clearInterval(latido);
      baja();
    });
    return reply; // la respuesta queda abierta
  });

  // Estado completo: lo que la app pinta al abrirse o al recibir un FCM.
  app.get('/api/conductor/estado', async (req) => {
    const sesion = await sesionDesde(req);
    const presencia = await pool.query(
      `SELECT p.estado, p.zona_id, z.nombre AS zona
       FROM presencia p LEFT JOIN zona z ON z.id = p.zona_id
       WHERE p.conductor_id = $1`,
      [sesion.conductorId],
    );
    const ofertas = await pool.query(
      `SELECT o.solicitud_id, o.oleada, s.expira_en,
              ro.nombre AS origen, rd.nombre AS destino,
              bp.p25, bp.p50, bp.p75
       FROM oferta o
       JOIN solicitud s ON s.id = o.solicitud_id
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       LEFT JOIN banda_precio bp
         ON bp.zona_origen_id = ro.zona_id AND bp.zona_destino_id = rd.zona_id
       WHERE o.conductor_id = $1 AND o.resultado IS NULL AND s.estado = 'EMITIDO'
       ORDER BY o.id`,
      [sesion.conductorId],
    );
    // Taxi compartido: TODOS los pasajeros comprometidos, en el orden en que
    // subieron. La app pinta un bloque con sus botones por cada uno.
    const pasajeros = await pool.query(
      `SELECT s.id AS solicitud_id, s.estado, s.telefono_cliente,
              v.id AS viaje_id, v.llegado_en,
              ro.nombre AS origen, ro.lat AS origen_lat, ro.lng AS origen_lng,
              rd.nombre AS destino, rd.lat AS destino_lat, rd.lng AS destino_lng
       FROM solicitud s
       JOIN viaje v ON v.solicitud_id = s.id
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       WHERE s.conductor_id = $1 AND s.estado IN ('ACEPTADO', 'EN_CAMINO', 'RECOGIDO')
       ORDER BY s.id`,
      [sesion.conductorId],
    );
    // Posición en vivo de cada pasajero que ESPERA (decisión de sesión): el
    // taxista necesita saber dónde está de verdad, no solo la referencia que
    // dijo. Se corta al subirse (RECOGIDO): van en el mismo coche y compartir
    // ubicación deja de tener sentido.
    const frescuraSeg = await leerParametroEntero(pool, 'gps_frescura_seg');
    const posicionesCliente = await pool.query(
      `SELECT DISTINCT ON (p.viaje_id) p.viaje_id, p.lat, p.lng,
              extract(epoch from (now() - p.creado_en))::int AS antiguedad
       FROM posicion p
       JOIN viaje v ON v.id = p.viaje_id
       JOIN solicitud s ON s.id = v.solicitud_id
       WHERE s.conductor_id = $1
         AND s.estado IN ('ACEPTADO', 'EN_CAMINO')
         AND p.actor = 'cliente'
         AND p.creado_en >= now() - make_interval(secs => $2)
       ORDER BY p.viaje_id, p.creado_en DESC`,
      [sesion.conductorId, frescuraSeg],
    );
    const porViaje = new Map<string, { lat: number; lng: number; frescuraSeg: number }>();
    for (const p of posicionesCliente.rows) {
      porViaje.set(String(p.viaje_id), {
        lat: Number(p.lat), lng: Number(p.lng), frescuraSeg: p.antiguedad,
      });
    }

    const relojSeg = await enTransaccion(pool, (c) => relojEsperaSeg(c, sesion.conductorId));
    const ocupacion = await ocupacionDe(pool, sesion.conductorId);
    const suscripcion = await pool.query(
      'SELECT suscrito_hasta FROM conductor WHERE id = $1',
      [sesion.conductorId],
    );

    return {
      estado: presencia.rows[0]?.estado ?? 'DESCONECTADO',
      zonaId: presencia.rows[0]?.zona_id ?? null,
      zona: presencia.rows[0]?.zona ?? null,
      saldoXaf: await saldoDe(sesion.conductorId),
      suscritoHasta: suscripcion.rows[0].suscrito_hasta,
      suscripcionVigente: suscripcion.rows[0].suscrito_hasta !== null
        && new Date(suscripcion.rows[0].suscrito_hasta) > new Date(),
      plazas: ocupacion.plazas,
      plazasLibres: ocupacion.libres,
      pasajerosABordo: ocupacion.aBordo,
      ofertas: ofertas.rows.map((o) => ({
        solicitudId: o.solicitud_id,
        origen: o.origen,
        destino: o.destino,
        oleada: o.oleada,
        expiraEn: o.expira_en,
        bandaPrecio: o.p50 === null ? null : { p25: Number(o.p25), p50: Number(o.p50), p75: Number(o.p75) },
      })),
      pasajeros: pasajeros.rows.map((fila) => ({
        solicitudId: fila.solicitud_id,
        viajeId: fila.viaje_id,
        estado: fila.estado,
        origen: fila.origen,
        origenLat: Number(fila.origen_lat),
        origenLng: Number(fila.origen_lng),
        destino: fila.destino,
        destinoLat: Number(fila.destino_lat),
        destinoLng: Number(fila.destino_lng),
        // Revelación R3: el teléfono solo a partir de EN_CAMINO.
        telefonoCliente: fila.estado === 'ACEPTADO' ? null : fila.telefono_cliente,
        llegadoEn: fila.llegado_en,
        relojEsperaSeg: relojSeg,
        // null si el pasajero no comparte ubicación o ya va a bordo.
        posicionCliente: porViaje.get(String(fila.viaje_id)) ?? null,
      })),
    };
  });

  // --- Ciclo del viaje ----------------------------------------------------

  app.post('/api/conductor/solicitudes/:id/aceptar', async (req) => {
    const sesion = await sesionDesde(req);
    const solicitudId = Number((req.params as { id: string }).id);
    try {
      const resultado = await reclamarSolicitud(pool, emisor, solicitudId, sesion.conductorId);
      // Sin teléfono del cliente: se entrega al confirmar la salida (R3).
      return resultado;
    } catch (error) {
      if (error instanceof ErrorOfertaInvalida) {
        throw errorHttp(409, error.message);
      }
      throw error;
    }
  });

  app.post('/api/conductor/solicitudes/:id/rechazar', async (req) => {
    const sesion = await sesionDesde(req);
    const solicitudId = Number((req.params as { id: string }).id);
    try {
      await rechazarOferta(pool, solicitudId, sesion.conductorId);
    } catch (error) {
      if (error instanceof ErrorOfertaInvalida) {
        throw errorHttp(409, error.message);
      }
      throw error;
    }
    return { rechazada: true };
  });

  app.post('/api/conductor/solicitudes/:id/salir', async (req) => {
    const sesion = await sesionDesde(req);
    const solicitudId = Number((req.params as { id: string }).id);
    return enTransaccion(pool, async (cliente) => {
      const solicitud = await solicitudDelConductor(cliente, solicitudId, sesion.conductorId, ['ACEPTADO']);
      await transicionarSolicitud(cliente, solicitudId, 'EN_CAMINO', 'conductor', 'app_conductor');
      // Este es el momento de la revelación del teléfono (R3).
      return { telefonoCliente: solicitud.telefonoCliente };
    });
  });

  app.post('/api/conductor/solicitudes/:id/he-llegado', async (req) => {
    const sesion = await sesionDesde(req);
    const solicitudId = Number((req.params as { id: string }).id);
    const cuerpo = (req.body ?? {}) as { lat?: number; lng?: number };
    return enTransaccion(pool, async (cliente) => {
      const solicitud = await solicitudDelConductor(cliente, solicitudId, sesion.conductorId, ['EN_CAMINO']);
      const res = await cliente.query(
        `UPDATE viaje SET llegado_en = COALESCE(llegado_en, now()),
                          lat_llegada = COALESCE($2, lat_llegada),
                          lng_llegada = COALESCE($3, lng_llegada)
         WHERE id = $1 RETURNING llegado_en`,
        [
          solicitud.viajeId,
          typeof cuerpo.lat === 'number' ? cuerpo.lat : null,
          typeof cuerpo.lng === 'number' ? cuerpo.lng : null,
        ],
      );
      const relojSeg = await relojEsperaSeg(cliente, sesion.conductorId);
      return { llegadoEn: res.rows[0].llegado_en, relojEsperaSeg: relojSeg };
    });
  });

  app.post('/api/conductor/solicitudes/:id/cliente-ausente', async (req) => {
    const sesion = await sesionDesde(req);
    const solicitudId = Number((req.params as { id: string }).id);
    return enTransaccion(pool, async (cliente) => {
      const solicitud = await solicitudDelConductor(cliente, solicitudId, sesion.conductorId, ['EN_CAMINO']);
      if (solicitud.llegadoEn === null) {
        throw errorHttp(409, 'Antes de declarar ausencia tienes que pulsar «he llegado» y esperar el reloj.');
      }
      const relojSeg = await relojEsperaSeg(cliente, sesion.conductorId);
      const restante = Math.ceil(
        (solicitud.llegadoEn.getTime() + relojSeg * 1000 - Date.now()) / 1000,
      );
      if (restante > 0) {
        throw errorHttp(409, `El reloj de espera aún no se ha agotado: quedan ${restante} segundos.`);
      }

      await transicionarSolicitud(cliente, solicitudId, 'CLIENTE_AUSENTE', 'conductor', 'reloj_agotado');
      // R4: si el cliente tenía sesión SSE viva, NUNCA sanción automática.
      const resultado = await procesarClienteAusente(
        cliente,
        solicitud.viajeId,
        conexionesSse.tieneConexion(solicitud.dispositivoClienteId),
      );
      await ajustarPresencia(cliente, sesion.conductorId, 'sistema', 'cliente_ausente');
      return { revisionManual: !resultado.strikeAplicado };
    });
  });

  app.post('/api/conductor/solicitudes/:id/recoger', async (req) => {
    const sesion = await sesionDesde(req);
    const solicitudId = Number((req.params as { id: string }).id);
    const cuerpo = (req.body ?? {}) as { pin?: string; lat?: number; lng?: number };
    // Validación manual sin PIN (estilo Cabify): el PIN es opcional; si la
    // app lo envía, debe coincidir. La recogida también puede marcarla sola
    // la proximidad GPS (procesarProximidad) antes de que nadie pulse nada.
    if (cuerpo.pin !== undefined && !/^[0-9]{4}$/.test(cuerpo.pin)) {
      throw errorHttp(400, 'El PIN, si se envía, son 4 dígitos.');
    }
    return enTransaccion(pool, async (cliente) => {
      const solicitud = await solicitudDelConductor(cliente, solicitudId, sesion.conductorId, ['EN_CAMINO']);
      const viaje = await cliente.query('SELECT pin FROM viaje WHERE id = $1', [solicitud.viajeId]);
      if (cuerpo.pin !== undefined && viaje.rows[0].pin !== cuerpo.pin) {
        throw errorHttp(400, 'PIN incorrecto. Pídele al pasajero que te lo dicte otra vez.');
      }
      await transicionarSolicitud(
        cliente, solicitudId, 'RECOGIDO', 'conductor',
        cuerpo.pin !== undefined ? 'pin_validado' : 'confirmacion_manual',
      );

      // Señal antifraude (migración 010): lectura GPS única del conductor al
      // validar y distancia a la referencia de origen. NUNCA bloquea la
      // validación: la discrepancia la juzga el paso 10 con contexto.
      let distanciaM: number | null = null;
      if (typeof cuerpo.lat === 'number' && typeof cuerpo.lng === 'number') {
        const origen = await cliente.query(
          `SELECT r.lat, r.lng FROM solicitud s
           JOIN referencia r ON r.id = s.referencia_origen_id
           WHERE s.id = $1`,
          [solicitudId],
        );
        distanciaM = distanciaMetros(
          cuerpo.lat, cuerpo.lng,
          Number(origen.rows[0].lat), Number(origen.rows[0].lng),
        );
      }
      await cliente.query(
        `UPDATE viaje SET validado_en = now(),
                          lat_validacion = $2, lng_validacion = $3, distancia_validacion_m = $4
         WHERE id = $1`,
        [
          solicitud.viajeId,
          typeof cuerpo.lat === 'number' ? cuerpo.lat : null,
          typeof cuerpo.lng === 'number' ? cuerpo.lng : null,
          distanciaM,
        ],
      );
      return { recogido: true, distanciaValidacionM: distanciaM };
    });
  });

  // Cierre del viaje. Sin precio: la plataforma no registra cuánto se pagó
  // (migración 012). Si la separación GPS ya lo cerró, esta llamada es un
  // no-op idempotente.
  app.post('/api/conductor/solicitudes/:id/completar', async (req) => {
    const sesion = await sesionDesde(req);
    const solicitudId = Number((req.params as { id: string }).id);
    return enTransaccion(pool, async (cliente) => {
      // Si la separación GPS ya cerró el viaje (COMPLETADO), aquí solo se
      // registra el precio del conductor; si no, el cierre es manual.
      const solicitud = await solicitudDelConductor(
        cliente, solicitudId, sesion.conductorId, ['RECOGIDO', 'COMPLETADO'],
      );
      if (solicitud.estado === 'RECOGIDO') {
        await transicionarSolicitud(cliente, solicitudId, 'COMPLETADO', 'conductor', 'app_conductor');
        // Se libera una plaza: DISPONIBLE si estaba lleno, y si ya lo estaba
        // (llevaba a otros con hueco) no hay transición que hacer.
        await ajustarPresencia(cliente, sesion.conductorId, 'conductor', 'viaje_cerrado');
      }
      await cliente.query(
        'UPDATE viaje SET completado_en = COALESCE(completado_en, now()) WHERE id = $1',
        [solicitud.viajeId],
      );
      // Con suscripción no hay comisión por viaje: el cierre no cobra nada.
      const umbral = await leerParametroEntero(cliente, 'umbral_saldo_bajo_xaf');
      const saldo = await saldoDe(sesion.conductorId);
      if (saldo < umbral) {
        await emisor.emitir({
          tipo: 'D4_saldo_bajo',
          rol: 'conductor',
          solicitudId,
          conductorId: sesion.conductorId,
          datos: { saldoXaf: saldo, umbralXaf: umbral },
        }, cliente);
      }
      return { saldoXaf: saldo };
    });
  });
}
