// Identidad y estadísticas comunes a los dos roles (migración 016).
//
// Un dispositivo es de pasajero o de conductor, nunca de los dos: es lo que
// decide qué interfaz se muestra al abrir la app. Se elige al registrarse y
// solo el operador puede cambiarlo (borrando el registro), porque el historial
// y los strikes cuelgan del dispositivo.
//
// Recordatorio (P15-04): esto NO es autenticación. Ni el teléfono ni el correo
// se verifican. La identidad real sigue siendo el uuid del dispositivo.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { enTransaccion } from '../bd/conexion.js';
import { ocupacionDe } from '../dominio/ocupacion.js';
import { reputacionDe } from '../dominio/reputacion.js';
import { normalizarTelefono } from '../dominio/telefono.js';
import { esOperador } from './operador.js';

const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARROCERIAS = ['turismo', '4x4'];

function errorHttp(codigo: number, mensaje: string): Error & { statusCode: number } {
  const error = new Error(mensaje) as Error & { statusCode: number };
  error.statusCode = codigo;
  return error;
}

export function registrarRutasSesion(app: FastifyInstance, pool: pg.Pool): void {
  function uuidDesde(req: FastifyRequest): string {
    const uuid = req.headers['x-dispositivo'] as string | undefined;
    if (!uuid || !PATRON_UUID.test(uuid)) {
      throw errorHttp(400, 'Falta la cabecera x-dispositivo con un UUID válido.');
    }
    return uuid.toLowerCase();
  }

  // Qué es este dispositivo. Lo primero que pide la app al abrirse: decide si
  // muestra la elección de rol, la interfaz del pasajero o la del taxista.
  app.get('/api/sesion', async (req) => {
    const uuid = uuidDesde(req);
    // El operador no tiene fila en `dispositivo`: es una lista aparte
    // (UUIDS_OPERADOR), así que se resuelve antes de mirar esa tabla.
    if (esOperador(uuid)) {
      return { rol: 'operador' };
    }
    const dispositivo = await pool.query(
      `SELECT id, tipo, conductor_id, bloqueado_en FROM dispositivo WHERE uuid_persistente = $1`,
      [uuid],
    );
    if (dispositivo.rowCount === 0) {
      return { rol: null };
    }
    const fila = dispositivo.rows[0];

    if (fila.tipo === 'conductor' && fila.conductor_id !== null) {
      const conductor = await pool.query(
        `SELECT c.nombre, c.telefono, c.correo, c.estado_verificacion, c.suscrito_hasta,
                c.es_agente, c.telefono_verificado_en,
                v.matricula, v.marca, v.color, v.carroceria, v.plazas,
                sm.saldo_xaf
         FROM conductor c
         LEFT JOIN vehiculo v ON v.conductor_id = c.id
         LEFT JOIN saldo_monedero sm ON sm.conductor_id = c.id
         WHERE c.id = $1`,
        [fila.conductor_id],
      );
      const c = conductor.rows[0];
      const reputacion = await reputacionDe(pool, fila.conductor_id);
      return {
        rol: 'conductor',
        conductor: {
          nombre: c.nombre,
          telefono: c.telefono,
          correo: c.correo,
          verificado: c.estado_verificacion === 'verificado',
          estadoVerificacion: c.estado_verificacion,
          // Migración 027: el teléfono es siempre obligatorio para un
          // conductor, así que aquí el gate se aplica siempre.
          telefonoVerificado: c.telefono_verificado_en !== null,
          suscritoHasta: c.suscrito_hasta,
          suscripcionVigente: c.suscrito_hasta !== null && new Date(c.suscrito_hasta) > new Date(),
          saldoXaf: c.saldo_xaf === null ? 0 : Number(c.saldo_xaf),
          matricula: c.matricula,
          marca: c.marca,
          color: c.color,
          carroceria: c.carroceria,
          plazas: c.plazas,
          // Agente de campo (migración 025): el mismo panel de taxi, más las
          // herramientas para situar barrios, corregir sitios y fijar precios.
          agente: c.es_agente,
          reputacion,
        },
      };
    }

    const perfil = await pool.query(
      'SELECT telefono, correo, nombre, edad, genero, telefono_verificado_en FROM perfil_cliente WHERE dispositivo_id = $1',
      [fila.id],
    );
    if (perfil.rowCount === 0) {
      return { rol: null };
    }
    const p = perfil.rows[0];
    return {
      rol: 'cliente',
      cliente: {
        telefono: p.telefono,
        correo: p.correo,
        nombre: p.nombre,
        edad: p.edad,
        genero: p.genero,
        // Migración 027: sin teléfono (solo correo, migración 015) no hay
        // nada que verificar por SMS — exento, no bloqueado.
        telefonoVerificado: p.telefono === null || p.telefono_verificado_en !== null,
        bloqueado: fila.bloqueado_en !== null,
      },
    };
  });

  // Alta propia del taxista. Queda PENDIENTE de verificación: sin ella no
  // recibe ni una oferta. Es la salvaguarda de que nadie se convierte en taxi
  // solo por escribir una matrícula.
  app.post('/api/conductor/alta', async (req) => {
    const uuid = uuidDesde(req);
    const cuerpo = (req.body ?? {}) as {
      nombre?: string; telefono?: string; correo?: string;
      matricula?: string; marca?: string; carroceria?: string; color?: string;
    };

    const nombre = cuerpo.nombre?.trim();
    // Forma canónica (migración 024): el teléfono es la clave natural del
    // conductor, y sin normalizar el mismo taxista podía acabar con dos fichas
    // —cada una con su monedero y su reputación— según cómo teclease.
    const telefonoCrudo = cuerpo.telefono?.trim();
    const telefono = normalizarTelefono(telefonoCrudo);
    const correo = cuerpo.correo?.trim().toLowerCase() || null;
    const matricula = cuerpo.matricula?.trim().toUpperCase();
    const marca = cuerpo.marca?.trim();
    const carroceria = cuerpo.carroceria;

    if (!nombre || !telefonoCrudo || !matricula || !marca || !carroceria) {
      throw errorHttp(400, 'Faltan datos: nombre, teléfono, matrícula, marca y carrocería son obligatorios.');
    }
    if (!telefono) {
      throw errorHttp(400, `Teléfono no válido: «${telefonoCrudo}».`);
    }

    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) {
      throw errorHttp(400, `Correo no válido: «${correo}».`);
    }
    if (!CARROCERIAS.includes(carroceria)) {
      throw errorHttp(400, `Carrocería no válida. Opciones: ${CARROCERIAS.join(', ')}.`);
    }

    return enTransaccion(pool, async (cliente) => {
      const yaEsDispositivo = await cliente.query(
        'SELECT tipo, conductor_id FROM dispositivo WHERE uuid_persistente = $1',
        [uuid],
      );
      if ((yaEsDispositivo.rowCount ?? 0) > 0 && yaEsDispositivo.rows[0].tipo === 'cliente') {
        throw errorHttp(409, 'Este teléfono ya se registró como pasajero. Habla con el operador para cambiarlo.');
      }

      // El teléfono es la clave natural del conductor: si ya existe, se
      // reutiliza (es el mismo taxista reinstalando la app).
      const existente = await cliente.query(
        'SELECT id, estado_verificacion FROM conductor WHERE telefono = $1',
        [telefono],
      );
      let conductorId: number;
      if ((existente.rowCount ?? 0) > 0) {
        conductorId = existente.rows[0].id;
        // Auto-aceptar (decisión del 2026-07-28, «por ahora», ver
        // PENDIENTES.md P21-01) también al reenviar el alta, no solo al
        // crearla: si no, alguien que ya tenía una fila 'pendiente' de antes
        // de esta decisión se quedaba pendiente para siempre, porque el
        // único sitio donde se ponía 'verificado' era el INSERT. No toca
        // 'suspendido' ni 'bloqueado': eso lo decide el operador, y volver a
        // enviar el formulario no puede servir para saltárselo.
        await cliente.query(
          `UPDATE conductor SET nombre = $2, correo = COALESCE($3, correo),
             estado_verificacion = CASE WHEN estado_verificacion = 'pendiente'
               THEN 'verificado' ELSE estado_verificacion END
           WHERE id = $1`,
          [conductorId, nombre, correo],
        );
      } else {
        // Verificado de entrada, sin revisión manual: todavía no hay panel de
        // operador desde el que comprobar los datos (pendiente, ver
        // PENDIENTES.md). Cuando exista, esto vuelve a nacer 'pendiente'.
        const creado = await cliente.query(
          `INSERT INTO conductor (telefono, nombre, correo, estado_verificacion)
           VALUES ($1, $2, $3, 'verificado') RETURNING id`,
          [telefono, nombre, correo],
        );
        conductorId = creado.rows[0].id;
      }

      const matriculaAjena = await cliente.query(
        'SELECT conductor_id FROM vehiculo WHERE matricula = $1 AND conductor_id <> $2',
        [matricula, conductorId],
      );
      if ((matriculaAjena.rowCount ?? 0) > 0) {
        throw errorHttp(409, `La matrícula ${matricula} ya está registrada por otro conductor.`);
      }

      const vehiculo = await cliente.query(
        'SELECT id FROM vehiculo WHERE conductor_id = $1',
        [conductorId],
      );
      if ((vehiculo.rowCount ?? 0) > 0) {
        await cliente.query(
          `UPDATE vehiculo SET matricula = $2, marca = $3, carroceria = $4, color = COALESCE($5, color)
           WHERE conductor_id = $1`,
          [conductorId, matricula, marca, carroceria, cuerpo.color?.trim() || null],
        );
      } else {
        await cliente.query(
          `INSERT INTO vehiculo (conductor_id, matricula, marca, carroceria, color)
           VALUES ($1, $2, $3, $4, $5)`,
          [conductorId, matricula, marca, carroceria, cuerpo.color?.trim() || null],
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
           SET tipo = 'conductor', conductor_id = EXCLUDED.conductor_id, ultimo_heartbeat = now()`,
        [uuid, conductorId],
      );

      const estado = await cliente.query(
        'SELECT estado_verificacion FROM conductor WHERE id = $1',
        [conductorId],
      );
      return {
        conductorId,
        estadoVerificacion: estado.rows[0].estado_verificacion,
        // La app lo dice con estas palabras: es la diferencia entre «ya
        // trabajas» y «espera a que te verifiquen».
        aviso: estado.rows[0].estado_verificacion === 'verificado'
          ? null
          : 'Tu alta está pendiente de verificación. No recibirás carreras hasta que el operador compruebe tus datos.',
      };
    });
  });

  // Panel de estadísticas de uso, distinto según el rol.
  app.get('/api/estadisticas', async (req) => {
    const uuid = uuidDesde(req);
    const dispositivo = await pool.query(
      'SELECT id, tipo, conductor_id FROM dispositivo WHERE uuid_persistente = $1',
      [uuid],
    );
    if (dispositivo.rowCount === 0) {
      throw errorHttp(404, 'Este dispositivo no está registrado.');
    }
    const fila = dispositivo.rows[0];

    if (fila.tipo === 'conductor' && fila.conductor_id !== null) {
      const resumen = await pool.query(
        `SELECT
           count(*) FILTER (WHERE s.estado = 'COMPLETADO')::int AS completados,
           count(*) FILTER (WHERE s.estado = 'CANCELADO_CONDUCTOR')::int AS cancelados,
           count(*) FILTER (WHERE s.estado = 'CLIENTE_AUSENTE')::int AS ausencias,
           count(*)::int AS aceptados
         FROM solicitud s WHERE s.conductor_id = $1`,
        [fila.conductor_id],
      );
      const ofertas = await pool.query(
        `SELECT count(*)::int AS recibidas,
                count(*) FILTER (WHERE resultado = 'aceptada')::int AS aceptadas,
                count(*) FILTER (WHERE resultado = 'rechazada')::int AS rechazadas,
                count(*) FILTER (WHERE resultado = 'expirada')::int AS perdidas
         FROM oferta WHERE conductor_id = $1`,
        [fila.conductor_id],
      );
      const apuntes = await pool.query(
        `SELECT
           COALESCE(sum(importe_xaf) FILTER (WHERE a.tipo = 'recarga'), 0)::int AS recargado,
           COALESCE(-sum(importe_xaf) FILTER (WHERE a.tipo = 'suscripcion'), 0)::int AS pagado_suscripcion
         FROM apunte a JOIN monedero m ON m.id = a.monedero_id
         WHERE m.conductor_id = $1`,
        [fila.conductor_id],
      );
      const zonas = await pool.query(
        `SELECT z.nombre, count(*)::int AS viajes
         FROM solicitud s
         JOIN referencia r ON r.id = s.referencia_origen_id
         JOIN zona z ON z.id = r.zona_id
         WHERE s.conductor_id = $1 AND s.estado = 'COMPLETADO'
         GROUP BY z.nombre ORDER BY viajes DESC LIMIT 5`,
        [fila.conductor_id],
      );
      const ocupacion = await ocupacionDe(pool, fila.conductor_id);
      const reputacion = await reputacionDe(pool, fila.conductor_id);
      return {
        rol: 'conductor',
        viajes: resumen.rows[0],
        ofertas: ofertas.rows[0],
        monedero: apuntes.rows[0],
        zonasFrecuentes: zonas.rows,
        ocupacion,
        reputacion,
      };
    }

    const resumen = await pool.query(
      `SELECT
         count(*)::int AS pedidos,
         count(*) FILTER (WHERE estado = 'COMPLETADO')::int AS completados,
         count(*) FILTER (WHERE estado = 'SIN_OFERTA')::int AS sin_taxi,
         count(*) FILTER (WHERE estado = 'CANCELADO_CLIENTE')::int AS cancelados
       FROM solicitud WHERE dispositivo_cliente_id = $1`,
      [fila.id],
    );
    const destinos = await pool.query(
      `SELECT r.nombre, count(*)::int AS veces
       FROM solicitud s JOIN referencia r ON r.id = s.referencia_destino_id
       WHERE s.dispositivo_cliente_id = $1
       GROUP BY r.nombre ORDER BY veces DESC LIMIT 5`,
      [fila.id],
    );
    const strikes = await pool.query(
      'SELECT strikes, bloqueado_en FROM dispositivo WHERE id = $1',
      [fila.id],
    );
    return {
      rol: 'cliente',
      viajes: resumen.rows[0],
      destinosFrecuentes: destinos.rows,
      strikes: strikes.rows[0].strikes,
      bloqueado: strikes.rows[0].bloqueado_en !== null,
    };
  });
}
