// Panel de operador (PENDIENTES.md P21-01): verificar altas de conductor y
// ver estadísticas básicas del sistema entero.
//
// Se identifica al operador por el dispositivo, no por contraseña — igual
// que hoy se distingue cliente de conductor por su fila en `dispositivo`.
// La lista de uuids autorizados vive en la variable de entorno
// UUIDS_OPERADOR (separados por comas); no hay tabla propia porque son pocos
// y cambian poco, y así no hace falta una alta con contraseña para esto.

import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { enTransaccion } from '../bd/conexion.js';
import { iniciarDespacho } from '../dominio/despacho.js';
import { ErrorEntidadInexistente } from '../dominio/errores.js';
import type { EmisorEventos } from '../dominio/eventos.js';
import {
  anadirAlias, editarReferencia, guardarReferencia, quitarAlias,
} from '../dominio/gazetteer.js';
import { leerParametroEntero } from '../dominio/parametros.js';
import { confirmarRecarga, rechazarRecarga, recargasDe } from '../dominio/recargas.js';
import { reputacionDe } from '../dominio/reputacion.js';
import { normalizarTelefono } from '../dominio/telefono.js';
import { crearZonaEnGps, situarZona } from '../dominio/zonas.js';
import { crearSolicitud } from '../dominio/transiciones.js';

const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESTADOS_VALIDOS = ['pendiente', 'verificado', 'suspendido', 'bloqueado'];
const ESTADOS_RECARGA_VALIDOS = ['pendiente', 'confirmada', 'rechazada', 'caducada'];

// Las mismas del CHECK de la migración 021. Se validan aquí para poder decir
// qué se puede poner: sin esto, escribir una categoría que no está en la lista
// llegaba a la base y salía por pantalla el error en crudo del CHECK, que no
// dice cuáles son las válidas ni qué hacer.
const CATEGORIAS_VALIDAS = [
  'mercado', 'iglesia', 'hospital', 'farmacia', 'escuela', 'deporte',
  'gobierno', 'transporte', 'gasolinera', 'plaza', 'otro',
  'hotel', 'banco', 'restaurante', 'zona',
];

function exigirCategoria(categoria: string | undefined): string | undefined {
  const limpia = categoria?.trim();
  if (!limpia) return undefined;
  if (!CATEGORIAS_VALIDAS.includes(limpia)) {
    throw errorHttp(
      400,
      `Categoría «${limpia}» no válida. Elige una de: ${CATEGORIAS_VALIDAS.join(', ')}.`,
    );
  }
  return limpia;
}

// La isla entera, no solo Malabo ciudad. Un GPS que todavía no ha fijado
// devuelve a veces (0, 0) o una posición de hace días en otro país: guardar
// eso como el centro de un barrio dejaría el reparto tocado y nadie sabría
// por qué.
//
// Antes el recuadro era el de Malabo ciudad (3,695–3,815 N / 8,705–8,845 E),
// el mismo con el que se compiló el plano de calles. Pero el catálogo ya
// llega a Luba, Moka, Riaba, Batoicopo y los Basacato: veintiséis de los
// cincuenta barrios situados caían FUERA, así que no se podían situar ni
// corregir desde el panel y había que tocarlos por SQL. Sigue rechazando lo
// que importa —el (0,0), la costa de Bata, Annobón— porque Bioko es una isla
// pequeña y aislada.
const RECUADRO_BIOKO = { sur: 3.18, oeste: 8.38, norte: 3.81, este: 8.99 };

function enBioko(lat: number, lng: number): boolean {
  return lat >= RECUADRO_BIOKO.sur && lat <= RECUADRO_BIOKO.norte
    && lng >= RECUADRO_BIOKO.oeste && lng <= RECUADRO_BIOKO.este;
}

// Lo que el recuadro NO puede detectar: un punto dentro de Malabo pero malo.
// Un teléfono con el GPS sin fijar contesta con la celda de telefonía o la
// wifi —cientos o miles de metros de radio—, y eso cae dentro del recuadro
// tan campante. El centroide decide qué barrios son vecinos y cuál se le
// ofrece antes al taxista: mal situado, manda taxis al sitio equivocado
// durante meses sin que nadie sepa por qué.
async function exigirGpsFiable(
  pool: pg.Pool,
  precision: unknown,
): Promise<number | null> {
  const maxima = await leerParametroEntero(pool, 'gps_precision_maxima_m');
  if (typeof precision !== 'number' || !Number.isFinite(precision) || precision < 0) {
    throw errorHttp(
      400,
      'Falta la precisión del GPS. Hay que tomar la posición con el GPS del '
      + 'teléfono, no escribirla a mano.',
    );
  }
  if (precision > maxima) {
    throw errorHttp(
      400,
      `El GPS solo da ±${Math.round(precision)} m y hacen falta ±${maxima} m o `
      + 'mejor. Sal a cielo abierto, espera unos segundos a que fije y repite.',
    );
  }
  return precision;
}

// La precisión de un LUGAR. A diferencia de un barrio, aquí se permite no
// mandarla: a veces se añade un sitio desde la oficina sabiendo dónde está, y
// prohibirlo dejaría el catálogo sin sitios que alguien conoce de sobra. Pero
// si viene, se valida con la misma vara que la de un barrio, y si no viene se
// guarda NULL — que es lo que el panel enseña como «sin verificar sobre el
// terreno» para poder repasarlo después.
async function precisionDeSitio(pool: pg.Pool, precision: unknown): Promise<number | null> {
  if (precision === undefined || precision === null) return null;
  return exigirGpsFiable(pool, precision);
}

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

export function registrarRutasOperador(
  app: FastifyInstance,
  pool: pg.Pool,
  emisor: EmisorEventos,
): void {
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

  // Trabajo de campo: situar barrios, corregir sitios y fijar precios. Lo
  // pueden hacer el operador y los conductores nombrados agentes (migracion
  // 025). Es mas ancho que `exigirOperador` a proposito: el trabajo de campo
  // se hace en la calle, y quien esta en la calle es el taxista.
  //
  // Lo que NO abre: verificar conductores, confirmar pagos, resolver
  // incidencias ni tocar parametros. Un agente corrige el mapa, no administra
  // a sus companeros ni el dinero.
  async function exigirCampo(req: FastifyRequest): Promise<void> {
    const uuid = uuidDesde(req);
    if (esOperador(uuid)) return;
    const agente = await pool.query(
      `SELECT 1 FROM dispositivo d
       JOIN conductor c ON c.id = d.conductor_id
       WHERE d.uuid_persistente = $1 AND d.tipo = 'conductor' AND c.es_agente`,
      [uuid],
    );
    if (agente.rowCount === 0) {
      throw errorHttp(403, 'Este dispositivo no puede hacer trabajo de campo.');
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
              v.matricula, v.marca, v.color, v.carroceria,
              v.aire_acondicionado, v.seguro
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
              c.suscrito_hasta, c.es_agente,
              v.matricula, v.marca, v.color, v.carroceria, v.plazas,
              v.aire_acondicionado, v.seguro,
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

  // Nombrar agente de campo a un conductor, o retirarle el papel. Solo el
  // operador: es quien conoce a la gente y quien responde de lo que toquen.
  app.post('/api/operador/conductores/:id/agente', async (req) => {
    exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    const { agente } = (req.body ?? {}) as { agente?: boolean };
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');
    if (typeof agente !== 'boolean') throw errorHttp(400, 'Falta agente (true/false).');
    const res = await pool.query(
      'UPDATE conductor SET es_agente = $2 WHERE id = $1 RETURNING id, nombre, es_agente',
      [id, agente],
    );
    if (res.rowCount === 0) throw errorHttp(404, 'Conductor no encontrado.');
    return res.rows[0];
  });

  // Corregir aire acondicionado y seguro (migración 028): lo declara el
  // conductor en su alta, pero el operador puede corregirlo si ve mal el
  // dato (o si el conductor nunca lo llegó a marcar).
  app.post('/api/operador/conductores/:id/vehiculo', async (req) => {
    exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    const { aireAcondicionado, seguro } = (req.body ?? {}) as {
      aireAcondicionado?: boolean; seguro?: boolean;
    };
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');
    if (typeof aireAcondicionado !== 'boolean' || typeof seguro !== 'boolean') {
      throw errorHttp(400, 'Faltan aireAcondicionado y seguro (true/false).');
    }
    const res = await pool.query(
      `UPDATE vehiculo SET aire_acondicionado = $2, seguro = $3
       WHERE conductor_id = $1
       RETURNING conductor_id, aire_acondicionado, seguro`,
      [id, aireAcondicionado, seguro],
    );
    if (res.rowCount === 0) throw errorHttp(404, 'Este conductor no tiene vehículo dado de alta.');
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

  // --- Cuadro de mandos (bloque 1) -------------------------------------------
  // La salud del sistema de un vistazo, y las alarmas de la sección 11 de la
  // especificación evaluadas de verdad: los umbrales `alarma_*` llevaban en
  // la tabla parametro desde el paso 1 sin que nadie los consumiera.

  app.get('/api/operador/salud', async (req) => {
    exigirOperador(req);

    const umbralesRes = await pool.query(
      `SELECT clave, valor FROM parametro WHERE clave LIKE 'alarma%'`,
    );
    const umbral = new Map<string, number>(
      umbralesRes.rows.map((f: { clave: string; valor: string }) => [f.clave, Number(f.valor)]),
    );

    const taxisPorZona = await pool.query(
      `SELECT z.nombre AS zona, count(*)::int AS taxis,
              count(*) FILTER (WHERE p.estado = 'DISPONIBLE')::int AS disponibles
       FROM presencia p JOIN zona z ON z.id = p.zona_id
       WHERE p.estado != 'DESCONECTADO'
       GROUP BY z.nombre ORDER BY taxis DESC, z.nombre`,
    );
    const enCurso = await pool.query(
      `SELECT estado, count(*)::int AS n FROM solicitud
       WHERE estado IN ('SOLICITADO', 'EMITIDO', 'ACEPTADO', 'EN_CAMINO', 'RECOGIDO')
       GROUP BY estado`,
    );

    // Tasa de «sin oferta» por zona, últimas 24 horas. Con menos de 5
    // peticiones no se opina: dos solicitudes fallidas de madrugada no son
    // una alarma, son madrugada.
    const MUESTRA_MINIMA = 5;
    const sinOferta = await pool.query(
      `SELECT z.nombre AS zona, count(*)::int AS pedidas,
              count(*) FILTER (WHERE s.estado = 'SIN_OFERTA')::int AS sin_taxi
       FROM solicitud s
       JOIN referencia r ON r.id = s.referencia_origen_id
       JOIN zona z ON z.id = r.zona_id
       WHERE s.creada_en >= now() - interval '24 hours'
       GROUP BY z.nombre HAVING count(*) >= ${MUESTRA_MINIMA}`,
    );
    const zonasSinTaxi = sinOferta.rows
      .map((f: { zona: string; pedidas: number; sin_taxi: number }) => ({
        nombre: f.zona, muestras: f.pedidas, tasa: f.sin_taxi / f.pedidas,
      }))
      .filter((f) => f.tasa >= (umbral.get('alarma_tasa_sin_oferta_max') ?? 1))
      .sort((a, b) => b.tasa - a.tasa);

    // Por conductor, últimos 30 días: ausencias declaradas y cancelaciones
    // tras aceptar. Son las dos formas de quemar pasajeros.
    const porConductor = await pool.query(
      `SELECT c.nombre, count(*)::int AS asignados,
              count(*) FILTER (WHERE s.estado IN ('NO_PRESENTADO', 'CLIENTE_AUSENTE'))::int AS ausencias,
              count(*) FILTER (WHERE s.estado = 'CANCELADO_CONDUCTOR')::int AS cancelados
       FROM solicitud s JOIN conductor c ON c.id = s.conductor_id
       WHERE s.creada_en >= now() - interval '30 days'
       GROUP BY c.id, c.nombre HAVING count(*) >= ${MUESTRA_MINIMA}`,
    );
    const filaConductor = (f: { nombre: string; asignados: number; ausencias: number; cancelados: number }) => f;
    const conductoresAusencias = porConductor.rows
      .map(filaConductor)
      .map((f) => ({ nombre: f.nombre, muestras: f.asignados, tasa: f.ausencias / f.asignados }))
      .filter((f) => f.tasa >= (umbral.get('alarma_tasa_no_presentado_max') ?? 1))
      .sort((a, b) => b.tasa - a.tasa);
    const conductoresCancelan = porConductor.rows
      .map(filaConductor)
      .map((f) => ({ nombre: f.nombre, muestras: f.asignados, tasa: f.cancelados / f.asignados }))
      .filter((f) => f.tasa >= (umbral.get('alarma_tasa_acept_cancel_max') ?? 1))
      .sort((a, b) => b.tasa - a.tasa);

    // Validación de recogidas (R5): viajes completados cuya recogida quedó
    // validada (PIN o proximidad GPS). Si baja, la comisión se está cobrando
    // a ciegas o no se está cobrando.
    const validacion = await pool.query(
      `SELECT count(*)::int AS completados,
              count(*) FILTER (WHERE v.validado_en IS NOT NULL)::int AS validados
       FROM solicitud s JOIN viaje v ON v.solicitud_id = s.id
       WHERE s.estado = 'COMPLETADO' AND s.creada_en >= now() - interval '7 days'`,
    );
    const completados = validacion.rows[0].completados as number;
    const tasaValidacion = completados >= MUESTRA_MINIMA
      ? validacion.rows[0].validados / completados
      : null;

    const alarmas = [
      {
        clave: 'alarma_tasa_sin_oferta_max',
        nombre: 'Zonas que se quedan sin taxi',
        ambito: 'por zona, últimas 24 h',
        umbral: umbral.get('alarma_tasa_sin_oferta_max') ?? null,
        disparada: zonasSinTaxi.length > 0,
        detalle: zonasSinTaxi,
      },
      {
        clave: 'alarma_tasa_no_presentado_max',
        nombre: 'Conductores con demasiadas ausencias',
        ambito: 'por conductor, últimos 30 días',
        umbral: umbral.get('alarma_tasa_no_presentado_max') ?? null,
        disparada: conductoresAusencias.length > 0,
        detalle: conductoresAusencias,
      },
      {
        clave: 'alarma_tasa_acept_cancel_max',
        nombre: 'Conductores que aceptan y cancelan',
        ambito: 'por conductor, últimos 30 días',
        umbral: umbral.get('alarma_tasa_acept_cancel_max') ?? null,
        disparada: conductoresCancelan.length > 0,
        detalle: conductoresCancelan,
      },
      {
        clave: 'alarma_tasa_validacion_min',
        nombre: 'Recogidas sin validar',
        ambito: 'global, últimos 7 días',
        umbral: umbral.get('alarma_tasa_validacion_min') ?? null,
        // Sin muestra suficiente no hay opinión, y sin opinión no hay alarma.
        disparada: tasaValidacion !== null
          && tasaValidacion < (umbral.get('alarma_tasa_validacion_min') ?? 0),
        detalle: tasaValidacion === null
          ? []
          : [{ nombre: 'validadas', muestras: completados, tasa: tasaValidacion }],
      },
      {
        clave: 'alarma_coste_mensajeria_xaf',
        nombre: 'Coste de mensajería por viaje',
        ambito: 'sin fuente de datos: no hay mensajería de pago contratada',
        umbral: umbral.get('alarma_coste_mensajeria_xaf') ?? null,
        disparada: false,
        detalle: [],
      },
    ];

    return {
      taxisPorZona: taxisPorZona.rows,
      viajesEnCurso: enCurso.rows,
      alarmas,
    };
  });

  // --- Central telefónica (bloque 4, canal de voz 3.6) -----------------------
  // Quien no tiene la aplicación llama por teléfono y el operador pide por
  // él. El dominio lo soporta desde el paso 1 (actor 'operador'); esto solo
  // le pone puerta. Cada teléfono que llama tiene su propio «dispositivo»
  // sintético, así conserva historial y strikes como cualquier usuario.

  app.post('/api/operador/solicitudes', async (req, reply) => {
    exigirOperador(req);
    const cuerpo = (req.body ?? {}) as { telefono?: string; origenId?: number; destinoId?: number };
    // Canónico también aquí: si no, quien llama dos veces con el número escrito
    // de dos formas tendría dos identidades y dos historiales (migración 024).
    const telefono = normalizarTelefono(cuerpo.telefono);
    if (!telefono) {
      throw errorHttp(400, `Hace falta el teléfono de quien llama (recibido: «${cuerpo.telefono ?? ''}»).`);
    }
    if (!cuerpo.origenId || !cuerpo.destinoId) {
      throw errorHttp(400, 'Faltan campos: origenId y destinoId son obligatorios.');
    }
    if (cuerpo.origenId === cuerpo.destinoId) {
      throw errorHttp(400, 'El origen y el destino no pueden ser la misma referencia.');
    }

    const dispositivoId = await enTransaccion(pool, async (cliente) => {
      // El mismo teléfono que ya llamó otras veces reutiliza su dispositivo
      // sintético (el más reciente si hubiera varios perfiles con el número).
      const existente = await cliente.query(
        `SELECT d.id, d.bloqueado_en
         FROM perfil_cliente pc JOIN dispositivo d ON d.id = pc.dispositivo_id
         WHERE pc.telefono = $1 AND pc.telefono_vigente AND d.tipo = 'cliente'
         ORDER BY d.id DESC LIMIT 1`,
        [telefono],
      );
      if ((existente.rowCount ?? 0) > 0) {
        if (existente.rows[0].bloqueado_en !== null) {
          throw errorHttp(403, 'Ese teléfono está bloqueado por incidencias repetidas. Revisa su ficha en Pasajeros.');
        }
        return existente.rows[0].id as number;
      }
      const dispositivo = await cliente.query(
        `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES ($1, 'cliente') RETURNING id`,
        [randomUUID()],
      );
      await cliente.query(
        `INSERT INTO perfil_cliente (dispositivo_id, telefono) VALUES ($1, $2)`,
        [dispositivo.rows[0].id, telefono],
      );
      return dispositivo.rows[0].id as number;
    });

    // La misma idempotencia que la app (R1): si el operador pulsa dos veces,
    // no se piden dos taxis.
    const ventana = Math.floor(Date.now() / 60_000);
    const clave = createHash('sha256')
      .update(`${dispositivoId}|${cuerpo.origenId}|${cuerpo.destinoId}|${ventana}`)
      .digest('hex');

    const creada = await enTransaccion(pool, (c) => crearSolicitud(c, {
      dispositivoClienteId: dispositivoId,
      telefonoCliente: telefono,
      referenciaOrigenId: cuerpo.origenId!,
      referenciaDestinoId: cuerpo.destinoId!,
      actor: 'operador',
      claveIdempotencia: clave,
      origenEvento: 'llamada_voz',
    }));

    if (!creada.yaExistia) {
      const despacho = await iniciarDespacho(pool, emisor, creada.solicitudId);
      return reply.status(201).send({
        solicitudId: creada.solicitudId, estado: despacho.resultado, yaExistia: false,
      });
    }
    const actual = await pool.query('SELECT estado FROM solicitud WHERE id = $1', [creada.solicitudId]);
    return reply.send({
      solicitudId: creada.solicitudId, estado: actual.rows[0].estado, yaExistia: true,
    });
  });

  // Las últimas solicitudes de la central, con lo que el operador tiene que
  // dictar por teléfono: estado, y matrícula cuando hay taxi asignado.
  app.get('/api/operador/solicitudes', async (req) => {
    exigirOperador(req);
    const filas = await pool.query(
      `SELECT s.id, s.estado, s.creada_en, s.telefono_cliente,
              ro.nombre AS origen, rd.nombre AS destino,
              c.nombre AS conductor, v.matricula
       FROM solicitud s
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       LEFT JOIN conductor c ON c.id = s.conductor_id
       LEFT JOIN vehiculo v ON v.conductor_id = c.id
       WHERE EXISTS (
         SELECT 1 FROM transicion t
         WHERE t.solicitud_id = s.id AND t.actor = 'operador' AND t.estado_nuevo = 'SOLICITADO'
       )
       ORDER BY s.creada_en DESC LIMIT 20`,
    );
    return { solicitudes: filas.rows };
  });

  // --- Editor del gazetteer (bloque 5) ---------------------------------------
  // El catálogo de sitios es trabajo de campo continuo (P1-03): un nombre
  // nuevo, un alias como se dice de palabra, unas coordenadas corregidas.
  // Hasta ahora todo eso era SQL a mano.

  app.get('/api/operador/zonas', async (req) => {
    await exigirCampo(req);
    // Las no situadas primero: son la cola de trabajo. Ocho barrios de Malabo
    // entraron sin coordenadas porque ninguna fuente sabía dónde están
    // (migración 025), y hasta que alguien vaya, no existen para el reparto.
    const filas = await pool.query(
      `SELECT z.id, z.nombre, z.distrito, z.distrito_urbano, z.zona_padre_id,
              z.centroide_lat AS lat, z.centroide_lng AS lng,
              z.precision_gps_m AS precision_m,
              (z.centroide_lat IS NULL) AS sin_situar,
              (SELECT count(*)::int FROM referencia r WHERE r.zona_id = z.id AND r.activa) AS referencias,
              (SELECT count(*)::int FROM zona_adyacencia a WHERE a.zona_id = z.id) AS vecinas
       FROM zona z ORDER BY (z.centroide_lat IS NULL) DESC, z.nombre`,
    );
    return { zonas: filas.rows };
  });

  // «Estoy aquí»: sitúa un barrio con el GPS de quien lo pulsa. Recalcula la
  // adyacencia entera, porque un barrio sin vecinos es un barrio al que el
  // reparto no llega en la tercera oleada.
  app.post('/api/operador/zonas/:id/situar', async (req) => {
    await exigirCampo(req);
    const id = Number((req.params as { id: string }).id);
    const { lat, lng, precision } = (req.body ?? {}) as {
      lat?: number; lng?: number; precision?: number;
    };
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de zona no válido.');
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      throw errorHttp(400, 'Faltan las coordenadas (lat, lng).');
    }
    if (!enBioko(lat, lng)) {
      throw errorHttp(400, 'Esas coordenadas caen fuera de Bioko. ¿Se cogió el GPS de verdad?');
    }
    const precisionM = await exigirGpsFiable(pool, precision);
    try {
      return await enTransaccion(pool, (cliente) => situarZona(cliente, id, lat, lng, precisionM));
    } catch (error) {
      if (error instanceof Error && /No existe la zona/.test(error.message)) {
        throw errorHttp(404, error.message);
      }
      throw error;
    }
  });

  // Un barrio que no estaba en ninguna lista. Pasa: quien va por la calle
  // encuentra barrios que ni OSM ni el censo tenían.
  //
  // Con zonaPadreId (migración 031): en vez de un distrito urbano nuevo,
  // crea un barrio/calle dentro de uno existente — mismo botón «estoy
  // aquí», sin adyacencia propia (crearZonaEnGps se encarga).
  app.post('/api/operador/zonas', async (req) => {
    await exigirCampo(req);
    const { nombre, lat, lng, precision, zonaPadreId } = (req.body ?? {}) as {
      nombre?: string; lat?: number; lng?: number; precision?: number; zonaPadreId?: number;
    };
    const limpio = nombre?.trim();
    if (!limpio) throw errorHttp(400, 'Falta el nombre del barrio.');
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      throw errorHttp(400, 'Faltan las coordenadas (lat, lng).');
    }
    if (!enBioko(lat, lng)) {
      throw errorHttp(400, 'Esas coordenadas caen fuera de Bioko. ¿Se cogió el GPS de verdad?');
    }
    const precisionM = await exigirGpsFiable(pool, precision);
    try {
      return await enTransaccion(pool, (cliente) => crearZonaEnGps(
        cliente, limpio, lat, lng, precisionM, zonaPadreId ?? null,
      ));
    } catch (error) {
      if (error instanceof Error && /No existe la zona|ya es un barrio\/calle|Ya existe/.test(error.message)) {
        throw errorHttp(400, error.message);
      }
      throw error;
    }
  });

  app.get('/api/operador/referencias', async (req) => {
    await exigirCampo(req);
    const { q, zonaId } = (req.query ?? {}) as { q?: string; zonaId?: string };
    // A diferencia del buscador de los pasajeros, este ve TODO: inactivas
    // incluidas, porque para reactivar algo primero hay que encontrarlo.
    const filas = await pool.query(
      `SELECT r.id, r.nombre, r.lat, r.lng, r.categoria, r.activa,
              r.veces_usada AS usos, r.precision_gps_m AS precision_m,
              z.id AS zona_id, z.nombre AS zona,
              COALESCE((SELECT array_agg(a.alias ORDER BY a.alias)
                        FROM referencia_alias a WHERE a.referencia_id = r.id), '{}') AS alias
       FROM referencia r JOIN zona z ON z.id = r.zona_id
       WHERE ($1::text IS NULL OR r.nombre ILIKE '%' || $1 || '%'
              OR EXISTS (SELECT 1 FROM referencia_alias a
                         WHERE a.referencia_id = r.id AND a.alias ILIKE '%' || $1 || '%'))
         AND ($2::bigint IS NULL OR r.zona_id = $2)
       ORDER BY r.veces_usada DESC, r.nombre
       LIMIT 50`,
      [q?.trim() || null, zonaId ? Number(zonaId) : null],
    );
    return { referencias: filas.rows };
  });

  app.post('/api/operador/referencias', async (req) => {
    await exigirCampo(req);
    const cuerpo = (req.body ?? {}) as {
      zonaId?: number; nombre?: string; lat?: number; lng?: number;
      categoria?: string; precision?: number;
    };
    if (!cuerpo.zonaId || !cuerpo.nombre?.trim()
      || typeof cuerpo.lat !== 'number' || typeof cuerpo.lng !== 'number') {
      throw errorHttp(400, 'Faltan campos: zonaId, nombre, lat y lng son obligatorios.');
    }
    if (!enBioko(cuerpo.lat, cuerpo.lng)) {
      throw errorHttp(400, 'Esas coordenadas caen fuera de Bioko. ¿Se cogió el GPS de verdad?');
    }
    const categoria = exigirCategoria(cuerpo.categoria);
    const precisionM = await precisionDeSitio(pool, cuerpo.precision);
    const resultado = await enTransaccion(pool, async (cliente) => {
      const r = await guardarReferencia(cliente, {
        zonaId: cuerpo.zonaId!, nombre: cuerpo.nombre!.trim(), lat: cuerpo.lat!, lng: cuerpo.lng!,
      });
      await editarReferencia(cliente, r.referenciaId, { categoria, precisionM });
      return r;
    });
    return resultado;
  });

  app.post('/api/operador/referencias/:id', async (req) => {
    await exigirCampo(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de referencia no válido.');
    const cambios = (req.body ?? {}) as {
      nombre?: string; zonaId?: number; lat?: number; lng?: number;
      activa?: boolean; categoria?: string; precision?: number;
    };
    // Al corregir vale la misma regla que al crear: una categoría inventada
    // llegaba a la base y salía el error del CHECK en crudo.
    if (cambios.categoria !== undefined) exigirCategoria(cambios.categoria);
    if (typeof cambios.lat === 'number' && typeof cambios.lng === 'number'
      && !enBioko(cambios.lat, cambios.lng)) {
      throw errorHttp(400, 'Esas coordenadas caen fuera de Bioko. ¿Se cogió el GPS de verdad?');
    }
    // Mover un sitio reescribe con qué confianza está puesto: si se corrige
    // con el GPS queda su precisión, y si se teclea a mano queda sin
    // verificar. Dejar la precisión vieja pegada a unas coordenadas nuevas
    // sería mentir sobre el dato.
    const { precision, ...resto } = cambios;
    const conPrecision = (typeof cambios.lat === 'number' || typeof cambios.lng === 'number')
      ? { ...resto, precisionM: await precisionDeSitio(pool, precision) }
      : resto;
    try {
      await enTransaccion(pool, (cliente) => editarReferencia(cliente, id, conPrecision));
    } catch (error) {
      if (error instanceof ErrorEntidadInexistente) throw errorHttp(404, error.message);
      throw error;
    }
    return { editada: true };
  });

  app.post('/api/operador/referencias/:id/alias', async (req) => {
    await exigirCampo(req);
    const id = Number((req.params as { id: string }).id);
    const { alias, quitar } = (req.body ?? {}) as { alias?: string; quitar?: boolean };
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de referencia no válido.');
    if (!alias?.trim()) throw errorHttp(400, 'Falta el alias.');
    try {
      await enTransaccion(pool, (cliente) => (quitar
        ? quitarAlias(cliente, id, alias.trim())
        : anadirAlias(cliente, id, alias.trim())));
    } catch (error) {
      if (error instanceof ErrorEntidadInexistente) throw errorHttp(404, error.message);
      if (error instanceof Error) throw errorHttp(409, error.message);
      throw error;
    }
    return { hecho: true };
  });

  // --- Bandas de precio y parámetros (bloque 6) ------------------------------
  // Desde la migración 012 las bandas no pueden calcularse de datos reales
  // (no se reporta precio): las mantiene el operador a mano por par de zonas
  // (P12-01), y el taxista las ve en el broadcast para no aceptar a ciegas.

  app.get('/api/operador/bandas', async (req) => {
    await exigirCampo(req);
    const filas = await pool.query(
      `SELECT b.id, b.zona_origen_id, b.zona_destino_id, b.p25, b.p50, b.p75,
              b.actualizada_en, zo.nombre AS zona_origen, zd.nombre AS zona_destino
       FROM banda_precio b
       JOIN zona zo ON zo.id = b.zona_origen_id
       JOIN zona zd ON zd.id = b.zona_destino_id
       ORDER BY zo.nombre, zd.nombre`,
    );
    return { bandas: filas.rows };
  });

  app.post('/api/operador/bandas', async (req) => {
    await exigirCampo(req);
    const cuerpo = (req.body ?? {}) as {
      zonaOrigenId?: number; zonaDestinoId?: number;
      p25?: number; p50?: number; p75?: number; borrar?: boolean;
    };
    if (!cuerpo.zonaOrigenId || !cuerpo.zonaDestinoId) {
      throw errorHttp(400, 'Faltan las zonas de origen y destino.');
    }
    if (cuerpo.borrar) {
      await pool.query(
        `DELETE FROM banda_precio WHERE zona_origen_id = $1 AND zona_destino_id = $2`,
        [cuerpo.zonaOrigenId, cuerpo.zonaDestinoId],
      );
      return { borrada: true };
    }
    const { p25, p50, p75 } = cuerpo;
    if (![p25, p50, p75].every((v) => Number.isInteger(v) && (v as number) >= 0)) {
      throw errorHttp(400, 'p25, p50 y p75 tienen que ser XAF enteros (el dinero es entero).');
    }
    if (!(p25! <= p50! && p50! <= p75!)) {
      throw errorHttp(400, 'La banda tiene que ir ordenada: p25 ≤ p50 ≤ p75.');
    }
    const res = await pool.query(
      `INSERT INTO banda_precio (zona_origen_id, zona_destino_id, p25, p50, p75)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (zona_origen_id, zona_destino_id)
         DO UPDATE SET p25 = EXCLUDED.p25, p50 = EXCLUDED.p50, p75 = EXCLUDED.p75,
                       actualizada_en = now()
       RETURNING id`,
      [cuerpo.zonaOrigenId, cuerpo.zonaDestinoId, p25, p50, p75],
    );
    return { bandaId: res.rows[0].id };
  });

  // Los parámetros del sistema: tiempos de oleada, tarifas, umbrales de
  // alarma… Cambian el comportamiento SIN desplegar, que es exactamente su
  // razón de existir — y también la razón de tratarlos con respeto.
  app.get('/api/operador/parametros', async (req) => {
    exigirOperador(req);
    const filas = await pool.query(
      'SELECT clave, valor, descripcion FROM parametro ORDER BY clave',
    );
    return { parametros: filas.rows };
  });

  app.post('/api/operador/parametros/:clave', async (req) => {
    exigirOperador(req);
    const { clave } = req.params as { clave: string };
    const { valor } = (req.body ?? {}) as { valor?: string };
    if (typeof valor !== 'string' || !valor.trim()) {
      throw errorHttp(400, 'Falta el valor.');
    }
    // Solo se actualizan claves que existen: crear parámetros nuevos desde
    // el panel sería inventarse configuración que ningún código lee.
    const res = await pool.query(
      `UPDATE parametro SET valor = $2 WHERE clave = $1 RETURNING clave, valor`,
      [clave, valor.trim()],
    );
    if (res.rowCount === 0) throw errorHttp(404, `No existe el parámetro «${clave}».`);
    return res.rows[0];
  });
}
