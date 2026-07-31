// Pruebas de la verificación de teléfono por SMS (migración 027).
// Requiere la base de desarrollo arrancada y migrada.
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { crearPool } from '../bd/conexion.js';
import { EmisorRegistro } from '../dominio/eventos.js';
import { ServicioVerificacionRegistro } from '../dominio/verificacion-telefono.js';
import { ConexionesSse } from '../eventos/adaptador-sse.js';
import { crearServidor } from './servidor.js';

let siguienteTelefono = Math.floor(Math.random() * 1_000_000);
function telefonoUnico(): string {
  siguienteTelefono = (siguienteTelefono + 1) % 1_000_000;
  return `+240222${String(siguienteTelefono).padStart(6, '0')}`;
}

let pool: pg.Pool;
let app: FastifyInstance;
let servicioVerificacion: ServicioVerificacionRegistro;

before(async () => {
  pool = crearPool();
  servicioVerificacion = new ServicioVerificacionRegistro();
  app = crearServidor(pool, new EmisorRegistro(), new ConexionesSse(), servicioVerificacion);
});

after(async () => {
  await app.close();
  await pool.end();
});

function cabeceras(uuid: string): Record<string, string> {
  return { 'x-dispositivo': uuid, 'content-type': 'application/json' };
}

async function llamar(
  metodo: 'GET' | 'POST' | 'PUT',
  ruta: string,
  uuid: string,
  cuerpo?: unknown,
): Promise<{ status: number; cuerpo: any }> {
  const res = await app.inject({
    method: metodo,
    url: ruta,
    headers: metodo === 'GET' ? { 'x-dispositivo': uuid } : cabeceras(uuid),
    ...(metodo === 'GET' ? {} : { payload: (cuerpo ?? {}) as Record<string, unknown> }),
  });
  return { status: res.statusCode, cuerpo: res.json() };
}

async function darDeAltaPasajero(telefono: string): Promise<string> {
  const uuid = randomUUID();
  const res = await llamar('PUT', '/api/perfil', uuid, { telefono });
  assert.equal(res.status, 200, JSON.stringify(res.cuerpo));
  return uuid;
}

async function darDeAltaConductor(telefono: string): Promise<string> {
  const uuid = randomUUID();
  const res = await llamar('POST', '/api/conductor/alta', uuid, {
    nombre: 'Conductor de prueba', telefono,
    matricula: `MB-${telefonoUnico().slice(-4)}`, marca: 'Toyota', carroceria: 'turismo',
  });
  assert.equal(res.status, 200, JSON.stringify(res.cuerpo));
  return uuid;
}

test('un pasajero recién dado de alta no está verificado, y GET /api/sesion lo dice', async () => {
  const telefono = telefonoUnico();
  const uuid = await darDeAltaPasajero(telefono);
  const sesion = await llamar('GET', '/api/sesion', uuid);
  assert.equal(sesion.cuerpo.rol, 'cliente');
  assert.equal(sesion.cuerpo.cliente.telefonoVerificado, false);
});

test('enviar y comprobar el código correcto verifica el teléfono', async () => {
  const telefono = telefonoUnico();
  const uuid = await darDeAltaPasajero(telefono);

  const envio = await llamar('POST', '/api/verificacion/enviar', uuid);
  assert.equal(envio.status, 200);
  assert.equal(envio.cuerpo.enviado, true);
  assert.ok(servicioVerificacion.enviados.includes(telefono));

  const codigo = servicioVerificacion.ultimoCodigoPara(telefono);
  assert.ok(codigo);

  const comprobar = await llamar('POST', '/api/verificacion/comprobar', uuid, { codigo });
  assert.equal(comprobar.status, 200);
  assert.equal(comprobar.cuerpo.verificado, true);

  const sesion = await llamar('GET', '/api/sesion', uuid);
  assert.equal(sesion.cuerpo.cliente.telefonoVerificado, true);
});

test('comprobar con un código incorrecto no verifica y da 400', async () => {
  const telefono = telefonoUnico();
  const uuid = await darDeAltaPasajero(telefono);
  await llamar('POST', '/api/verificacion/enviar', uuid);

  const comprobar = await llamar('POST', '/api/verificacion/comprobar', uuid, { codigo: '000000' });
  assert.equal(comprobar.status, 400);

  const sesion = await llamar('GET', '/api/sesion', uuid);
  assert.equal(sesion.cuerpo.cliente.telefonoVerificado, false);
});

test('reenviar antes del cooldown da 429', async () => {
  const telefono = telefonoUnico();
  const uuid = await darDeAltaPasajero(telefono);

  const primero = await llamar('POST', '/api/verificacion/enviar', uuid);
  assert.equal(primero.status, 200);

  const segundo = await llamar('POST', '/api/verificacion/enviar', uuid);
  assert.equal(segundo.status, 429);
});

test('un pasajero solo con correo está exento del gate', async () => {
  const uuid = randomUUID();
  const alta = await llamar('PUT', '/api/perfil', uuid, { correo: `pasajero-${randomUUID()}@example.com` });
  assert.equal(alta.status, 200, JSON.stringify(alta.cuerpo));

  const sesion = await llamar('GET', '/api/sesion', uuid);
  assert.equal(sesion.cuerpo.cliente.telefonoVerificado, true);

  const envio = await llamar('POST', '/api/verificacion/enviar', uuid);
  assert.equal(envio.status, 200);
  assert.equal(envio.cuerpo.enviado, false);
});

test('un conductor recién dado de alta no está verificado hasta comprobar el código', async () => {
  const telefono = telefonoUnico();
  const uuid = await darDeAltaConductor(telefono);

  const antes = await llamar('GET', '/api/sesion', uuid);
  assert.equal(antes.cuerpo.conductor.telefonoVerificado, false);

  await llamar('POST', '/api/verificacion/enviar', uuid);
  const codigo = servicioVerificacion.ultimoCodigoPara(telefono);
  await llamar('POST', '/api/verificacion/comprobar', uuid, { codigo });

  const despues = await llamar('GET', '/api/sesion', uuid);
  assert.equal(despues.cuerpo.conductor.telefonoVerificado, true);
});
