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

test('un evento sin NADIE a quien avisar falla ruidosamente', async () => {
  // Antes esto era «sin conductor», y dejó de valer con la migración 076: al
  // pasajero que se quedó sin taxi se le avisa por este mismo canal, y a él se
  // le busca por el teléfono con el que pidió, no por una ficha de taxista.
  //
  // Lo que sigue sin poder pasar es que un evento llegue aquí sin destinatario
  // de ninguno de los dos tipos: no hay a quién mandárselo y tiene que verse en
  // el registro en vez de quedarse callado.
  const adaptador = new AdaptadorWeb();
  await assert.rejects(
    () => adaptador.entregar({
      id: 2,
      tipo: 'C2_conductor_asignado',
      rol: 'cliente',
      solicitudId: null,
      conductorId: null,
      dispositivoClienteId: null,
      datos: {},
    }, pool as unknown as pg.ClientBase),
    /no tiene a quién avisar/,
  );
});

test('al pasajero se le avisa por su teléfono, no por una ficha de taxista', async () => {
  // El aviso de «ya hay taxi» (migración 076). Sin buzón no hay a dónde
  // mandarlo, y eso NO es un fallo: es un pasajero que no dio permiso de
  // notificaciones. Lo que importa aquí es que no se vaya por el camino del
  // taxista buscando un conductor que no existe.
  const dispositivo = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo)
     VALUES (gen_random_uuid(), 'cliente') RETURNING id`,
  );
  const adaptador = new AdaptadorWeb();
  const detalle = await adaptador.entregar({
    id: 3,
    tipo: 'C7_taxi_disponible',
    rol: 'cliente',
    solicitudId: null,
    conductorId: null,
    dispositivoClienteId: Number(dispositivo.rows[0].id),
    datos: { zona: 'Semu' },
  }, pool as unknown as pg.ClientBase);
  assert.equal(detalle, 'web_sin_suscripcion');
  await pool.query('DELETE FROM dispositivo WHERE id = $1', [dispositivo.rows[0].id]);
});
