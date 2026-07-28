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

const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESTADOS_VALIDOS = ['pendiente', 'verificado', 'suspendido', 'bloqueado'];

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

  // Lista de conductores, opcionalmente filtrada por estado. El caso
  // principal es «pendiente»: son los que esperan revisión.
  app.get('/api/operador/conductores', async (req) => {
    exigirOperador(req);
    const { estado } = (req.query ?? {}) as { estado?: string };
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
       WHERE $1::text IS NULL OR c.estado_verificacion = $1
       ORDER BY c.id DESC
       LIMIT 200`,
      [estado ?? null],
    );
    return { conductores: filas.rows };
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
    return {
      conductores: conductores.rows[0],
      enServicioAhora: enServicio.rows[0].n,
      solicitudes: solicitudes.rows[0],
      pasajeros: pasajeros.rows[0].n,
      saldoTotalMonederosXaf: saldo.rows[0].n,
    };
  });
}
