// Verificación de teléfono por SMS (migración 027). Enviar y comprobar un
// código Twilio Verify — ver src/dominio/verificacion-telefono.ts para el
// porqué esto no pasa por el bus de eventos.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { gastarVale } from '../dominio/vales.js';
import { leerParametroEntero } from '../dominio/parametros.js';
import type { ServicioVerificacionTelefono } from '../dominio/verificacion-telefono.js';

const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorHttp(codigo: number, mensaje: string): Error & { statusCode: number } {
  const error = new Error(mensaje) as Error & { statusCode: number };
  error.statusCode = codigo;
  return error;
}

interface FilaTelefono {
  tabla: 'conductor' | 'perfil_cliente';
  id: number;
  telefono: string | null;
  verificacionEnviadaEn: string | null;
  // La última llamada de verificación (migración 082). Cada canal, su reloj.
  llamadaEn: string | null;
}

export function registrarRutasVerificacion(
  app: FastifyInstance,
  pool: pg.Pool,
  servicioVerificacion: ServicioVerificacionTelefono,
): void {
  function uuidDesde(req: FastifyRequest): string {
    const uuid = req.headers['x-dispositivo'] as string | undefined;
    if (!uuid || !PATRON_UUID.test(uuid)) {
      throw errorHttp(400, 'Falta la cabecera x-dispositivo con un UUID válido.');
    }
    return uuid.toLowerCase();
  }

  // Encuentra la fila (conductor o perfil_cliente) dueña del teléfono a
  // verificar de este dispositivo. Un pasajero solo con correo no tiene fila
  // que verificar por SMS: se trata aparte, en las rutas.
  async function filaDelDispositivo(uuid: string): Promise<FilaTelefono | null> {
    const dispositivo = await pool.query(
      'SELECT id, tipo, conductor_id FROM dispositivo WHERE uuid_persistente = $1',
      [uuid],
    );
    if (dispositivo.rowCount === 0) {
      throw errorHttp(404, 'Este dispositivo no está registrado.');
    }
    const fila = dispositivo.rows[0];
    if (fila.tipo === 'conductor' && fila.conductor_id !== null) {
      const conductor = await pool.query(
        'SELECT id, telefono, verificacion_enviada_en, llamada_verificacion_en FROM conductor WHERE id = $1',
        [fila.conductor_id],
      );
      return { tabla: 'conductor', id: conductor.rows[0].id, telefono: conductor.rows[0].telefono, verificacionEnviadaEn: conductor.rows[0].verificacion_enviada_en, llamadaEn: conductor.rows[0].llamada_verificacion_en };
    }
    const perfil = await pool.query(
      'SELECT id, telefono, verificacion_enviada_en, llamada_verificacion_en FROM perfil_cliente WHERE dispositivo_id = $1',
      [fila.id],
    );
    if (perfil.rowCount === 0) {
      throw errorHttp(404, 'Este dispositivo no tiene perfil de pasajero.');
    }
    return { tabla: 'perfil_cliente', id: perfil.rows[0].id, telefono: perfil.rows[0].telefono, verificacionEnviadaEn: perfil.rows[0].verificacion_enviada_en, llamadaEn: perfil.rows[0].llamada_verificacion_en };
  }

  app.post('/api/verificacion/enviar', async (req) => {
    const uuid = uuidDesde(req);
    const fila = await filaDelDispositivo(uuid);
    if (!fila || !fila.telefono) {
      // Pasajero solo con correo (migración 015): no hay teléfono, no hay
      // nada que enviar. Exento del gate, no es un error.
      return { enviado: false, motivo: 'sin_telefono' };
    }
    // Por SMS salvo que pida la llamada (migración 081): en Malabo hay líneas
    // a las que el SMS no llega, y sin esto el alta se queda ahí parada.
    const canal = ((req.body ?? {}) as { canal?: string }).canal === 'llamada'
      ? 'llamada' as const
      : 'sms' as const;
    // Cada canal lleva su reloj (migración 082): esta pantalla manda el SMS
    // sola nada más abrirse, y con un solo freno el botón de «llamadme»
    // nacería siempre bloqueado un minuto — la salida de emergencia detrás de
    // la misma puerta atascada.
    const cooldownSeg = await leerParametroEntero(pool, 'verificacion_cooldown_seg');
    const anterior = canal === 'llamada' ? fila.llamadaEn : fila.verificacionEnviadaEn;
    if (anterior) {
      const segundosDesde = (Date.now() - new Date(anterior).getTime()) / 1000;
      if (segundosDesde < cooldownSeg) {
        throw errorHttp(429, `Espera ${Math.ceil(cooldownSeg - segundosDesde)} segundos antes de pedir otro código.`);
      }
    }
    await servicioVerificacion.enviarCodigo(fila.telefono, canal);
    await pool.query(
      canal === 'llamada'
        ? `UPDATE ${fila.tabla} SET llamada_verificacion_en = now() WHERE id = $1`
        : `UPDATE ${fila.tabla} SET verificacion_enviada_en = now() WHERE id = $1`,
      [fila.id],
    );
    return { enviado: true, canal };
  });

  app.post('/api/verificacion/comprobar', async (req) => {
    const uuid = uuidDesde(req);
    const cuerpo = (req.body ?? {}) as { codigo?: string };
    const codigo = cuerpo.codigo?.trim();
    if (!codigo) {
      throw errorHttp(400, 'Falta el código.');
    }
    const fila = await filaDelDispositivo(uuid);
    if (!fila || !fila.telefono) {
      return { verificado: true, motivo: 'sin_telefono' };
    }
    // El vale del operador vale aquí también (migración 081), y tiene que
    // valer: cuando el operador le cambia el número a alguien, el nuevo queda
    // sin verificar, y si a esa línea tampoco llega el SMS la persona se queda
    // sin poder trabajar. El vale es el operador diciendo «de esta línea
    // respondo yo», que es justo lo que verifica un teléfono aquí.
    const correcto = await servicioVerificacion.comprobarCodigo(fila.telefono, codigo)
      || await gastarVale(pool, fila.telefono, codigo, uuid);
    if (!correcto) {
      throw errorHttp(400, 'Código incorrecto.');
    }
    await pool.query(
      `UPDATE ${fila.tabla} SET telefono_verificado_en = now() WHERE id = $1`,
      [fila.id],
    );
    return { verificado: true };
  });
}
