// Pruebas de la notificación web al taxista (migración 058).
//
// Lo que NO se prueba aquí: que Google entregue el aviso. Eso es una petición
// HTTPS a un servicio de terceros y probarlo de verdad exigiría un navegador
// real suscrito. Lo que sí se prueba es todo lo que puede fallar por nuestra
// parte: que las claves se generen UNA vez y no cambien —una clave nueva
// invalida todas las suscripciones y apaga los avisos de toda la ciudad—, que
// un buzón repetido no se duplique, y que «no había a quién avisar» se
// distinga de «no se pudo avisar». Esa última distinción es la que decide si
// el bus reintenta diez veces o lo deja escrito y sigue.
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool } from '../bd/conexion.js';
import {
  clavesVapid, enviarAlConductor, guardarSuscripcion,
  olvidarClavesVapid, suscripcionesDelConductor,
} from './notificaciones.js';
import { AdaptadorWeb } from '../eventos/adaptador-web.js';

let pool: pg.Pool;

before(() => { pool = crearPool(); });
after(async () => { await pool.end(); });

// Un taxista con su dispositivo, que es a quien se le manda el aviso.
async function taxistaConMovil(): Promise<{ conductorId: number; dispositivoId: number }> {
  const telefono = `+2406${BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 12)}`) % 100_000_000n}`
    .padEnd(13, '0');
  const conductor = await pool.query(
    `INSERT INTO conductor (telefono, nombre) VALUES ($1, 'Taxi Aviso') RETURNING id`,
    [telefono],
  );
  const dispositivo = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id)
     VALUES (gen_random_uuid(), 'conductor', $1) RETURNING id`,
    [conductor.rows[0].id],
  );
  return {
    conductorId: Number(conductor.rows[0].id),
    dispositivoId: Number(dispositivo.rows[0].id),
  };
}

test('las claves VAPID se generan una vez y no vuelven a cambiar', async () => {
  const primeras = await clavesVapid(pool);
  assert.ok(primeras.publica.length > 40, 'la clave pública es base64url de 65 bytes');
  assert.ok(primeras.privada.length > 20);

  // Segunda llamada en el mismo proceso: la de memoria.
  assert.deepEqual(await clavesVapid(pool), primeras);

  // Y en un proceso nuevo —un despliegue— tienen que ser LAS MISMAS: si
  // cambiaran, todas las suscripciones de todos los taxistas dejarían de
  // valer y nadie volvería a oír una carrera hasta reinstalar.
  olvidarClavesVapid();
  assert.deepEqual(await clavesVapid(pool), primeras);

  const filas = await pool.query('SELECT count(*)::int AS n FROM clave_vapid');
  assert.equal(filas.rows[0].n, 1, 'una sola fila, la garantiza la tabla');
});

test('el mismo buzón dos veces es una suscripción, no dos', async () => {
  const { conductorId, dispositivoId } = await taxistaConMovil();
  const endpoint = `https://push.example/${randomUUID()}`;

  await guardarSuscripcion(pool, dispositivoId, { endpoint, p256dh: 'clave1', auth: 'auth1' });
  // El navegador vuelve a suscribirse al reabrir la aplicación: mismo buzón,
  // claves posiblemente nuevas.
  await guardarSuscripcion(pool, dispositivoId, { endpoint, p256dh: 'clave2', auth: 'auth2' });

  const buzones = await suscripcionesDelConductor(pool, conductorId);
  assert.equal(buzones.length, 1);
  assert.equal(buzones[0].clave_p256dh, 'clave2', 'se queda con las claves nuevas');
});

test('un taxista con dos móviles recibe el aviso en los dos', async () => {
  // Todos sus dispositivos y no el último: con el móvil del trabajo y el suyo
  // no hay forma de saber cuál tiene en la mano.
  const { conductorId, dispositivoId } = await taxistaConMovil();
  const segundo = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id)
     VALUES (gen_random_uuid(), 'conductor', $1) RETURNING id`,
    [conductorId],
  );
  await guardarSuscripcion(pool, dispositivoId, {
    endpoint: `https://push.example/${randomUUID()}`, p256dh: 'a', auth: 'b',
  });
  await guardarSuscripcion(pool, Number(segundo.rows[0].id), {
    endpoint: `https://push.example/${randomUUID()}`, p256dh: 'c', auth: 'd',
  });

  assert.equal((await suscripcionesDelConductor(pool, conductorId)).length, 2);
});

test('sin ningún buzón no hay error: no había a quién avisar', async () => {
  // Es el caso de todos los días: el taxista de la app de Android, o el que
  // dijo no al permiso. Si esto contara como fallo, el bus reintentaría diez
  // veces cada carrera de cada taxista sin buzón y llenaría el registro de
  // errores que no lo son.
  const { conductorId } = await taxistaConMovil();
  const resultado = await enviarAlConductor(pool, conductorId, { titulo: 'Hola' });
  assert.deepEqual(resultado, { entregados: 0, caducados: 0, error: null });
});

test('el adaptador distingue «no había a quién» de «no se pudo»', async () => {
  const { conductorId } = await taxistaConMovil();
  const adaptador = new AdaptadorWeb();
  const detalle = await adaptador.entregar({
    id: 1,
    tipo: 'D1_broadcast_solicitud',
    rol: 'conductor',
    solicitudId: null,
    conductorId,
    dispositivoClienteId: null,
    datos: { origen: 'Mercado Central', destino: 'Catedral' },
  }, pool as unknown as pg.ClientBase);

  // Queda escrito y se acaba: reintentar no le va a dar un buzón.
  assert.equal(detalle, 'web_sin_suscripcion');
});

test('un evento de notificación web sin conductor destinatario falla ruidosamente', async () => {
  // Un evento del pasajero enrutado por error a este canal no puede quedarse
  // callado: no hay a quién mandárselo y hay que verlo en el registro.
  const adaptador = new AdaptadorWeb();
  await assert.rejects(
    () => adaptador.entregar({
      id: 2,
      tipo: 'C2_conductor_asignado',
      rol: 'cliente',
      solicitudId: null,
      conductorId: null,
      dispositivoClienteId: 7,
      datos: {},
    }, pool as unknown as pg.ClientBase),
    /no tiene conductor destinatario/,
  );
});
