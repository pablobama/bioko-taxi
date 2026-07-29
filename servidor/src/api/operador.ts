// Panel de operador (PENDIENTES.md P21-01): verificar altas de conductor y
// ver estadísticas básicas del sistema entero.
//
// Se identifica al operador por el dispositivo, no por contraseña — igual
// que hoy se distingue cliente de conductor por su fila en `dispositivo`.
// La lista de uuids autorizados vive en la variable de entorno
// UUIDS_OPERADOR (separados por comas); no hay tabla propia porque son pocos
// y cambian poco, y así no hace falta una alta con contraseña para esto.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { enTransaccion } from '../bd/conexion.js';
import { ErrorEntidadInexistente } from '../dominio/errores.js';
import { leerParametroEntero } from '../dominio/parametros.js';
import { confirmarRecarga, rechazarRecarga, recargasDe } from '../dominio/recargas.js';
import { reputacionDe } from '../dominio/reputacion.js';

const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESTADOS_VALIDOS = ['pendiente', 'verificado', 'suspendido', 'bloqueado'];
const ESTADOS_RECARGA_VALIDOS = ['pendiente', 'confirmada', 'rechazada', 'caducada'];

function errorHttp(codigo: number, mensaje: string): Error & { statusCode: number } {
  const error = new Error(mensaje) as Error & { statusCode: number };
  error.statusCode = codigo;
  return error;
}

function uuidsOperador(): Set<string> {
  return new Set(
    (process.env.UUIDS_OPERADOR ?? '')
      .split(',')
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function esOperador(uuid: string): boolean {
  return uuidsOperador().has(uuid.toLowerCase());
}

export function registrarRutasOperador(app: FastifyInstance, pool: pg.Pool): void {
  function uuidDesde(req: FastifyRequest): string {
    const uuid = req.headers['x-dispositivo'] as string | undefined;
    if (!uuid || !PATRON_UUID.test(uuid)) {
      throw errorHttp(400, 'Falta la cabecera x-dispositivo con un UUID válido.');
    }
    return uuid.toLowerCase();
  }

  function exigirOperador(req: FastifyRequest): void {
    if (!esOperador(uuidDesde(req))) {
      throw errorHttp(403, 'Este dispositivo no tiene acceso de operador.');
    }
  }

  // Lista de conductores: filtrada por estado, o buscada por nombre,
  // teléfono o matrícula (q). El caso principal sigue siendo «pendiente»:
  // los que esperan revisión.
  app.get('/api/operador/conductores', async (req) => {
    exigirOperador(req);
    const { estado, q } = (req.query ?? {}) as { estado?: string; q?: string };
    if (estado && !ESTADOS_VALIDOS.includes(estado)) {
      throw errorHttp(400, `Estado no válido. Opciones: ${ESTADOS_VALIDOS.join(', ')}.`);
    }
    // Sin paginación de verdad todavía (lista corta en la práctica); el tope
    // es solo para no reventar la pantalla si algún día deja de serlo.
    const filas = await pool.query(
      `SELECT c.id, c.nombre, c.telefono, c.correo, c.estado_verificacion,
              v.matricula, v.marca, v.color, v.carroceria
       FROM conductor c
       LEFT JOIN vehiculo v ON v.conductor_id = c.id
       WHERE ($1::text IS NULL OR c.estado_verificacion = $1)
         AND ($2::text IS NULL
              OR c.nombre ILIKE '%' || $2 || '%'
              OR c.telefono LIKE '%' || $2 || '%'
              OR v.matricula ILIKE '%' || $2 || '%')
       ORDER BY c.id DESC
       LIMIT 200`,
      [estado ?? null, q?.trim() || null],
    );
    return { conductores: filas.rows };
  });

  // La ficha completa de un conductor: todo lo que el operador necesita para
  // decidir con conocimiento — vehículo, dinero, reputación e historial — en
  // una sola pantalla, sin ir a mirar la base de datos.
  app.get('/api/operador/conductores/:id', async (req) => {
    exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');

    const ficha = await pool.query(
      `SELECT c.id, c.nombre, c.telefono, c.correo, c.estado_verificacion,
              c.suscrito_hasta,
              v.matricula, v.marca, v.color, v.carroceria, v.plazas,
              p.estado AS presencia,
              COALESCE(sm.saldo_xaf, 0)::int AS saldo_xaf
       FROM conductor c
       LEFT JOIN vehiculo v ON v.conductor_id = c.id
       LEFT JOIN presencia p ON p.conductor_id = c.id
       LEFT JOIN saldo_monedero sm ON sm.conductor_id = c.id
       WHERE c.id = $1`,
      [id],
    );
    if (ficha.rowCount === 0) throw errorHttp(404, 'Conductor no encontrado.');

    const viajes = await pool.query(
      `SELECT count(*) FILTER (WHERE estado = 'COMPLETADO')::int AS completados,
              count(*) FILTER (WHERE estado = 'CANCELADO_CONDUCTOR')::int AS cancelados,
              count(*) FILTER (WHERE estado = 'CLIENTE_AUSENTE')::int AS ausencias,
              count(*)::int AS aceptados
       FROM solicitud WHERE conductor_id = $1`,
      [id],
    );
    const ofertas = await pool.query(
      `SELECT count(*)::int AS recibidas,
              count(*) FILTER (WHERE resultado = 'aceptada')::int AS aceptadas,
              count(*) FILTER (WHERE resultado = 'rechazada')::int AS rechazadas
       FROM oferta WHERE conductor_id = $1`,
      [id],
    );
    const ultimos = await pool.query(
      `SELECT s.id, s.estado, s.creada_en,
              ro.nombre AS origen, rd.nombre AS destino
       FROM solicitud s
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       WHERE s.conductor_id = $1
       ORDER BY s.creada_en DESC LIMIT 10`,
      [id],
    );
    const reputacion = await reputacionDe(pool, id);
    const recargas = await recargasDe(pool, id, 10);
    return {
      ...ficha.rows[0],
      suscripcionVigente: ficha.rows[0].suscrito_hasta !== null
        && new Date(ficha.rows[0].suscrito_hasta) > new Date(),
      reputacion,
      viajes: viajes.rows[0],
      ofertas: ofertas.rows[0],
      ultimosViajes: ultimos.rows,
      recargas,
    };
  });

  // Cambia el estado de verificación de un conductor: verificar, pero
  // también suspender o bloquear si hace falta echar a alguien atrás.
  app.post('/api/operador/conductores/:id/estado', async (req) => {
    exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    const { estado } = (req.body ?? {}) as { estado?: string };
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');
    if (!estado || !ESTADOS_VALIDOS.includes(estado)) {
      throw errorHttp(400, `Estado no válido. Opciones: ${ESTADOS_VALIDOS.join(', ')}.`);
    }
    const res = await pool.query(
      `UPDATE conductor SET estado_verificacion = $2 WHERE id = $1
       RETURNING id, nombre, estado_verificacion`,
      [id, estado],
    );
    if (res.rowCount === 0) throw errorHttp(404, 'Conductor no encontrado.');
    return res.rows[0];
  });

  // Números gruesos del sistema entero: para ver de un vistazo si algo va
  // mal (por ejemplo, muchas solicitudes SIN_OFERTA seguidas).
  app.get('/api/operador/estadisticas', async (req) => {
    exigirOperador(req);
    const conductores = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE estado_verificacion = 'pendiente')::int AS pendientes,
              count(*) FILTER (WHERE estado_verificacion = 'verificado')::int AS verificados,
              count(*) FILTER (WHERE estado_verificacion = 'suspendido')::int AS suspendidos,
              count(*) FILTER (WHERE estado_verificacion = 'bloqueado')::int AS bloqueados
       FROM conductor`,
    );
    const enServicio = await pool.query(
      `SELECT count(*)::int AS n FROM presencia WHERE estado != 'DESCONECTADO'`,
    );
    const solicitudes = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE estado = 'COMPLETADO')::int AS completadas,
              count(*) FILTER (WHERE estado = 'SIN_OFERTA')::int AS sin_taxi,
              count(*) FILTER (WHERE creada_en >= now() - interval '24 hours')::int AS ultimas_24h
       FROM solicitud`,
    );
    const pasajeros = await pool.query(
      `SELECT count(*)::int AS n FROM dispositivo WHERE tipo = 'cliente'`,
    );
    const saldo = await pool.query(
      `SELECT COALESCE(sum(saldo_xaf), 0)::int AS n FROM saldo_monedero`,
    );
    const incidencias = await pool.query(
      `SELECT count(*)::int AS n FROM incidencia WHERE resuelta_en IS NULL`,
    );
    const recargasPendientes = await pool.query(
      `SELECT count(*)::int AS n FROM recarga WHERE estado = 'pendiente'`,
    );
    return {
      conductores: conductores.rows[0],
      enServicioAhora: enServicio.rows[0].n,
      solicitudes: solicitudes.rows[0],
      pasajeros: pasajeros.rows[0].n,
      saldoTotalMonederosXaf: saldo.rows[0].n,
      incidenciasPendientes: incidencias.rows[0].n,
      recargasPendientes: recargasPendientes.rows[0].n,
    };
  });

  // --- Verificar pagos (migración 018) -------------------------------------
  // Recordatorio del propio dominio: la plataforma NO comprueba ningún pago
  // sola. Esto es la cola de recargas que un conductor dice haber pagado
  // (Muni Dinero o efectivo) y que alguien tiene que mirar y confirmar —o
  // rechazar— a mano antes de que el saldo suba.

  app.get('/api/operador/recargas', async (req) => {
    exigirOperador(req);
    const { estado } = (req.query ?? {}) as { estado?: string };
    if (estado && !ESTADOS_RECARGA_VALIDOS.includes(estado)) {
      throw errorHttp(400, `Estado no válido. Opciones: ${ESTADOS_RECARGA_VALIDOS.join(', ')}.`);
    }
    const filas = await pool.query(
      `SELECT r.id, r.referencia, r.importe_xaf, r.metodo, r.estado,
              r.solicitada_en, r.resuelta_en, r.resuelta_por, r.nota,
              c.id AS conductor_id, c.nombre AS conductor_nombre, c.telefono AS conductor_telefono
       FROM recarga r
       JOIN conductor c ON c.id = r.conductor_id
       WHERE $1::text IS NULL OR r.estado = $1
       ORDER BY r.solicitada_en DESC
       LIMIT 200`,
      [estado ?? 'pendiente'],
    );
    return { recargas: filas.rows };
  });

  app.post('/api/operador/recargas/:referencia/confirmar', async (req) => {
    const uuid = uuidDesde(req);
    exigirOperador(req);
    const { referencia } = req.params as { referencia: string };
    try {
      const resultado = await enTransaccion(pool, (cliente) => confirmarRecarga(cliente, referencia, uuid));
      return resultado;
    } catch (error) {
      if (error instanceof ErrorEntidadInexistente) throw errorHttp(404, error.message);
      if (error instanceof Error) throw errorHttp(409, error.message);
      throw error;
    }
  });

  app.post('/api/operador/recargas/:referencia/rechazar', async (req) => {
    const uuid = uuidDesde(req);
    exigirOperador(req);
    const { referencia } = req.params as { referencia: string };
    const { motivo } = (req.body ?? {}) as { motivo?: string };
    if (!motivo?.trim()) throw errorHttp(400, 'Hace falta un motivo para rechazar la recarga.');
    try {
      await enTransaccion(pool, (cliente) => rechazarRecarga(cliente, referencia, uuid, motivo.trim()));
      return { rechazada: true };
    } catch (error) {
      if (error instanceof Error) throw errorHttp(409, error.message);
      throw error;
    }
  });

  // --- Pasajeros ------------------------------------------------------------
  // Hasta ahora los pasajeros eran invisibles para el operador: no había ni
  // forma de buscar a la persona que llama quejándose de un bloqueo.

  app.get('/api/operador/pasajeros', async (req) => {
    exigirOperador(req);
    const { q } = (req.query ?? {}) as { q?: string };
    const filas = await pool.query(
      `SELECT d.id AS dispositivo_id, d.strikes, d.bloqueado_en, d.creado_en,
              pc.telefono, pc.correo, pc.nombre,
              (SELECT count(*)::int FROM solicitud s WHERE s.dispositivo_cliente_id = d.id) AS viajes
       FROM dispositivo d
       JOIN perfil_cliente pc ON pc.dispositivo_id = d.id
       WHERE d.tipo = 'cliente'
         AND ($1::text IS NULL
              OR pc.telefono LIKE '%' || $1 || '%'
              OR pc.nombre ILIKE '%' || $1 || '%'
              OR pc.correo ILIKE '%' || $1 || '%')
       ORDER BY d.bloqueado_en IS NOT NULL DESC, d.creado_en DESC
       LIMIT 100`,
      [q?.trim() || null],
    );
    return { pasajeros: filas.rows };
  });

  app.get('/api/operador/pasajeros/:dispositivoId', async (req) => {
    exigirOperador(req);
    const id = Number((req.params as { dispositivoId: string }).dispositivoId);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de dispositivo no válido.');
    const ficha = await pool.query(
      `SELECT d.id AS dispositivo_id, d.strikes, d.bloqueado_en, d.creado_en,
              pc.telefono, pc.correo, pc.nombre, pc.edad, pc.genero
       FROM dispositivo d
       JOIN perfil_cliente pc ON pc.dispositivo_id = d.id
       WHERE d.id = $1 AND d.tipo = 'cliente'`,
      [id],
    );
    if (ficha.rowCount === 0) throw errorHttp(404, 'Pasajero no encontrado.');
    const resumen = await pool.query(
      `SELECT count(*)::int AS pedidos,
              count(*) FILTER (WHERE estado = 'COMPLETADO')::int AS completados,
              count(*) FILTER (WHERE estado = 'CANCELADO_CLIENTE')::int AS cancelados,
              count(*) FILTER (WHERE estado IN ('NO_PRESENTADO', 'CLIENTE_AUSENTE'))::int AS ausencias
       FROM solicitud WHERE dispositivo_cliente_id = $1`,
      [id],
    );
    const ultimos = await pool.query(
      `SELECT s.id, s.estado, s.creada_en, c.nombre AS conductor,
              ro.nombre AS origen, rd.nombre AS destino
       FROM solicitud s
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       LEFT JOIN conductor c ON c.id = s.conductor_id
       WHERE s.dispositivo_cliente_id = $1
       ORDER BY s.creada_en DESC LIMIT 10`,
      [id],
    );
    return { ...ficha.rows[0], viajes: resumen.rows[0], ultimosViajes: ultimos.rows };
  });

  // Perdón del operador: strikes a cero y bloqueo levantado. Es la válvula
  // del sistema de strikes automático — sin ella, un bloqueo injusto (o tres
  // ausencias con excusa razonable) no tenía más salida que el SQL a mano.
  app.post('/api/operador/pasajeros/:dispositivoId/desbloquear', async (req) => {
    exigirOperador(req);
    const id = Number((req.params as { dispositivoId: string }).dispositivoId);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de dispositivo no válido.');
    const res = await pool.query(
      `UPDATE dispositivo SET strikes = 0, bloqueado_en = NULL
       WHERE id = $1 AND tipo = 'cliente'
       RETURNING id AS dispositivo_id, strikes, bloqueado_en`,
      [id],
    );
    if (res.rowCount === 0) throw errorHttp(404, 'Pasajero no encontrado.');
    return res.rows[0];
  });

  // --- Incidencias -----------------------------------------------------------
  // La cola de revisión manual. Hoy la alimenta el «cliente ausente con
  // sesión activa» (R4: nunca se sanciona automáticamente a alguien que
  // estaba mirando la pantalla); cualquier incidencia futura cae aquí igual.

  app.get('/api/operador/incidencias', async (req) => {
    exigirOperador(req);
    const { estado } = (req.query ?? {}) as { estado?: string };
    const soloPendientes = estado !== 'resueltas';
    const filas = await pool.query(
      `SELECT i.id, i.tipo, i.descripcion, i.creada_en,
              i.resuelta_por, i.resuelta_en, i.resolucion,
              s.id AS solicitud_id, s.estado AS estado_viaje, s.telefono_cliente,
              s.dispositivo_cliente_id, d.strikes, d.bloqueado_en,
              c.nombre AS conductor,
              ro.nombre AS origen, rd.nombre AS destino
       FROM incidencia i
       JOIN viaje v ON v.id = i.viaje_id
       JOIN solicitud s ON s.id = v.solicitud_id
       JOIN dispositivo d ON d.id = s.dispositivo_cliente_id
       JOIN conductor c ON c.id = v.conductor_id
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       WHERE ($1 AND i.resuelta_en IS NULL) OR (NOT $1 AND i.resuelta_en IS NOT NULL)
       ORDER BY i.creada_en ${soloPendientes ? 'ASC' : 'DESC'}
       LIMIT 100`,
      [soloPendientes],
    );
    return { incidencias: filas.rows };
  });

  // El historial del viaje de una incidencia: el log de transiciones dice
  // quién hizo qué y cuándo, que es justo lo que hace falta para juzgar.
  app.get('/api/operador/incidencias/:id/historial', async (req) => {
    exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de incidencia no válido.');
    // Dos preguntas distintas: si la incidencia existe (si no, 404) y qué
    // transiciones tiene su viaje (que pueden ser cero sin que sea un error).
    const incidencia = await pool.query(
      `SELECT v.solicitud_id FROM incidencia i JOIN viaje v ON v.id = i.viaje_id
       WHERE i.id = $1`,
      [id],
    );
    if (incidencia.rowCount === 0) throw errorHttp(404, 'Incidencia no encontrada.');
    const filas = await pool.query(
      `SELECT t.estado_anterior, t.estado_nuevo, t.actor, t.creado_en
       FROM transicion t
       WHERE t.solicitud_id = $1
       ORDER BY t.id`,
      [incidencia.rows[0].solicitud_id],
    );
    return { transiciones: filas.rows };
  });

  app.post('/api/operador/incidencias/:id/resolver', async (req) => {
    const uuid = uuidDesde(req);
    exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    const { accion } = (req.body ?? {}) as { accion?: string };
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de incidencia no válido.');
    if (accion !== 'sancionar' && accion !== 'perdonar') {
      throw errorHttp(400, 'Acción no válida: sancionar o perdonar.');
    }
    return enTransaccion(pool, async (cliente) => {
      const fila = await cliente.query(
        `SELECT i.id, i.resuelta_en, s.dispositivo_cliente_id
         FROM incidencia i
         JOIN viaje v ON v.id = i.viaje_id
         JOIN solicitud s ON s.id = v.solicitud_id
         WHERE i.id = $1 FOR UPDATE OF i`,
        [id],
      );
      if (fila.rowCount === 0) throw errorHttp(404, 'Incidencia no encontrada.');
      if (fila.rows[0].resuelta_en !== null) {
        throw errorHttp(409, 'Esta incidencia ya está resuelta.');
      }

      let strikes = null;
      let bloqueado = false;
      if (accion === 'sancionar') {
        // El mismo strike que habría aplicado el sistema (R4), solo que con
        // una persona delante que ha mirado el caso.
        const limite = await leerParametroEntero(cliente, 'strikes_para_bloqueo');
        const strike = await cliente.query(
          `UPDATE dispositivo
           SET strikes = strikes + 1,
               bloqueado_en = CASE WHEN strikes + 1 >= $2 THEN COALESCE(bloqueado_en, now())
                                   ELSE bloqueado_en END
           WHERE id = $1
           RETURNING strikes, bloqueado_en`,
          [fila.rows[0].dispositivo_cliente_id, limite],
        );
        strikes = strike.rows[0].strikes;
        bloqueado = strike.rows[0].bloqueado_en !== null;
      }

      await cliente.query(
        `UPDATE incidencia
         SET resuelta_por = $2, resuelta_en = now(),
             resolucion = $3
         WHERE id = $1`,
        [id, uuid, accion === 'sancionar' ? 'sancionado' : 'perdonado'],
      );
      return { incidenciaId: id, resolucion: accion === 'sancionar' ? 'sancionado' : 'perdonado', strikes, bloqueado };
    });
  });
}
