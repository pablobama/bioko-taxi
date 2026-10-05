// Las tres llamadas de «ya estoy registrado» (migración 078).
//
// El paso previo de las dos altas, en tres peticiones y en este orden:
//
//   1. `buscar`   — «¿hay algo con este número?» Sí o no, nada más.
//   2. `codigo`   — «mándame el SMS». Solo si había algo.
//   3. `reclamar` — «el código es éste». Aquí se entrega la cuenta.
//
// POR QUÉ NO VALEN LAS RUTAS DE VERIFICACIÓN QUE YA HABÍA. Las de
// `/api/verificacion/*` (migración 027) sacan el teléfono de la fila del
// dispositivo que llama, y el caso de aquí es precisamente el de un dispositivo
// que todavía no tiene fila ninguna: acaba de instalar la aplicación. El número
// viene en el cuerpo, no de la base, y eso cambia todo lo demás — porque un
// número escrito a mano puede ser el de cualquiera.
//
// DE AHÍ LAS TRES DEFENSAS, que son el grueso de este fichero:
//
//   · Un cupo de números distintos por hora y por aparato, para que «¿está
//     registrado?» no se convierta en una máquina de averiguar quién usa la
//     aplicación.
//   · Una espera entre SMS al mismo número, para que pulsar «reenviar» no le
//     llene el teléfono de mensajes a alguien que no ha pedido nada —ni cueste
//     dinero a la plataforma.
//   · Un tope de códigos fallados por número, porque seis cifras se aciertan
//     probando y lo que se abre probando es la cuenta de otro.
//
// Y una cuarta que no es un contador: el nombre del dueño no sale en `buscar`.
// Sale en `reclamar`, cuando ya se ha demostrado tener la línea en la mano.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { enTransaccion } from '../bd/conexion.js';
import {
  apuntarIntento,
  buscarPorTelefono,
  codigosFallados,
  codigosPedidos,
  CuentaNoEntregable,
  devolverCliente,
  devolverConductor,
  numerosPreguntados,
  ultimoCodigoEnviado,
} from '../dominio/cuentas.js';
import { leerParametroEntero } from '../dominio/parametros.js';
import { normalizarTelefono } from '../dominio/telefono.js';
import { gastarVale } from '../dominio/vales.js';
import type {
  CanalDeCodigo, ServicioVerificacionTelefono,
} from '../dominio/verificacion-telefono.js';

const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorHttp(codigo: number, mensaje: string): Error & { statusCode: number } {
  const error = new Error(mensaje) as Error & { statusCode: number };
  error.statusCode = codigo;
  return error;
}

export function registrarRutasCuenta(
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

  // Por dónde quiere que le llegue el código. SMS salvo que pida lo contrario:
  // la llamada cuesta más y molesta más, así que se usa cuando el SMS ya ha
  // fallado, que es cuando la persona pulsa «no me llega».
  function canalDesde(req: FastifyRequest): CanalDeCodigo {
    return ((req.body ?? {}) as { canal?: string }).canal === 'llamada'
      ? 'llamada'
      : 'sms';
  }

  // El número tal como llega, en forma canónica o un 400 que diga qué pasa.
  function telefonoDesde(req: FastifyRequest): string {
    const crudo = ((req.body ?? {}) as { telefono?: string }).telefono?.trim();
    if (!crudo) {
      throw errorHttp(400, 'Falta el teléfono.');
    }
    const telefono = normalizarTelefono(crudo);
    if (!telefono) {
      throw errorHttp(400, `Teléfono no válido: «${crudo}».`);
    }
    return telefono;
  }

  async function exigirActivada(): Promise<void> {
    if (await leerParametroEntero(pool, 'recuperacion_activada') !== 1) {
      throw errorHttp(503, 'La recuperación por teléfono está desactivada ahora mismo.');
    }
  }

  // 1. ¿Hay algo con este número? Dos booleanos y se acabó.
  app.post('/api/cuenta/buscar', async (req) => {
    await exigirActivada();
    const uuid = uuidDesde(req);
    const telefono = telefonoDesde(req);

    // El cupo se mira ANTES de consultar: si no, el que prueba números ya tiene
    // su respuesta cuando le decimos que no pregunte más.
    const tope = await leerParametroEntero(pool, 'recuperacion_consultas_hora');
    const yaPreguntados = await numerosPreguntados(pool, uuid);
    if (yaPreguntados >= tope) {
      // Se apunta también el intento rechazado: lo que interesa ver luego es
      // cuántas veces alguien se dio contra el tope, no cuántas lo rozó.
      await apuntarIntento(pool, uuid, telefono, 'buscar', false);
      throw errorHttp(429, 'Has consultado demasiados números. Prueba dentro de un rato.');
    }

    const hallazgo = await buscarPorTelefono(pool, telefono);
    await apuntarIntento(pool, uuid, telefono, 'buscar', true);
    return {
      ...hallazgo,
      // Para la pantalla: el número ya normalizado, que es el que se va a usar
      // en los dos pasos siguientes. Así la aplicación no tiene que repetir la
      // normalización ni acertarla igual que el servidor.
      telefono,
    };
  });

  // 2. El SMS. Solo para números que existen: mandar un código a un número que
  // no está registrado no sirve de nada y es la forma de usar la plataforma
  // para mandar mensajes a desconocidos.
  app.post('/api/cuenta/codigo', async (req) => {
    await exigirActivada();
    const uuid = uuidDesde(req);
    const telefono = telefonoDesde(req);

    const hallazgo = await buscarPorTelefono(pool, telefono);
    if (!hallazgo.conductor && !hallazgo.cliente) {
      throw errorHttp(404, 'Ese número no está registrado.');
    }

    // El mismo cupo que para preguntar: un aparato honrado manda un SMS, dos si
    // el primero no llegó, y siempre al mismo número. Diez números distintos en
    // una hora es otra cosa.
    if (await codigosPedidos(pool, uuid)
      >= await leerParametroEntero(pool, 'recuperacion_consultas_hora')) {
      throw errorHttp(429, 'Has pedido demasiados códigos. Prueba dentro de un rato.');
    }

    const fallos = await codigosFallados(pool, telefono);
    if (fallos >= await leerParametroEntero(pool, 'recuperacion_intentos_codigo')) {
      throw errorHttp(429, 'Demasiados códigos fallados con este número. Prueba dentro de una hora.');
    }

    const esperaSeg = await leerParametroEntero(pool, 'recuperacion_cooldown_seg');
    const ultimo = await ultimoCodigoEnviado(pool, telefono);
    if (ultimo) {
      const desde = (Date.now() - ultimo.getTime()) / 1000;
      if (desde < esperaSeg) {
        throw errorHttp(429, `Espera ${Math.ceil(esperaSeg - desde)} segundos antes de pedir otro código.`);
      }
    }

    const canal = canalDesde(req);
    await servicioVerificacion.enviarCodigo(telefono, canal);
    // Se apunta DESPUÉS de mandarlo: si Twilio falla, el reloj del cooldown no
    // se pone en marcha y la persona puede volver a intentarlo ya.
    await apuntarIntento(pool, uuid, telefono, 'codigo', true);
    return { enviado: true, canal };
  });

  // 3. El código, y con él la cuenta. `rol` lo manda la aplicación porque un
  // mismo número puede ser taxista Y pasajero —en producción los hay— y son dos
  // cuentas distintas: la que se recupera es la del papel que se eligió en la
  // pantalla anterior.
  app.post('/api/cuenta/reclamar', async (req) => {
    await exigirActivada();
    const uuid = uuidDesde(req);
    const telefono = telefonoDesde(req);
    const cuerpo = (req.body ?? {}) as { codigo?: string; rol?: string };
    const codigo = cuerpo.codigo?.trim();
    const rol = cuerpo.rol;
    if (!codigo) {
      throw errorHttp(400, 'Falta el código.');
    }
    if (rol !== 'conductor' && rol !== 'cliente') {
      throw errorHttp(400, 'Falta el papel que se recupera: conductor o cliente.');
    }

    if (await codigosFallados(pool, telefono)
      >= await leerParametroEntero(pool, 'recuperacion_intentos_codigo')) {
      throw errorHttp(429, 'Demasiados códigos fallados con este número. Prueba dentro de una hora.');
    }

    // Dos códigos valen aquí: el de Twilio y el vale que da el operador cuando
    // a esa línea no llega ni el SMS ni la llamada (migración 081). Se prueba
    // primero el de Twilio porque es el caso normal, y el vale solo si el otro
    // no era: así un vale sin gastar sigue sin gastarse mientras la persona
    // acierte con el del SMS.
    const correcto = await servicioVerificacion.comprobarCodigo(telefono, codigo)
      || await gastarVale(pool, telefono, codigo, uuid);
    if (!correcto) {
      await apuntarIntento(pool, uuid, telefono, 'reclamar', false);
      throw errorHttp(400, 'Código incorrecto.');
    }

    try {
      const cuenta = await enTransaccion(pool, (cliente) => (
        rol === 'conductor'
          ? devolverConductor(cliente, uuid, telefono)
          : devolverCliente(cliente, uuid, telefono)
      ));
      await apuntarIntento(pool, uuid, telefono, 'reclamar', true);
      return cuenta;
    } catch (error) {
      if (error instanceof CuentaNoEntregable) {
        // El código era bueno: el que no se puede entregar es este papel. No
        // cuenta como código fallado, porque no lo fue, y contarlo dejaría a la
        // persona sin intentos por un problema que no es suyo.
        throw errorHttp(error.codigoHttp, error.message);
      }
      throw error;
    }
  });
}
