// El tiempo de llegada con la velocidad real del coche (migración 053).
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { estimarLlegada, llegadaDeViaje, velocidadRecienteKmh } from './llegada.js';
import { rutaParaLlegar } from './carreteras.js';
import { distanciaMetros } from './geo.js';

let pool: pg.Pool;

before(() => { pool = crearPool(); });
after(async () => { await pool.end(); });

// Malabo y Luba, a ojo de mapa. Son las dos puntas del problema que se vio en
// producción: 142 minutos para un trayecto que se hace en unos cuarenta.
const MALABO = { lat: 3.7523, lng: 8.7742 };
const LUBA = { lat: 3.4560, lng: 8.5560 };
const CERCA = { lat: 3.7600, lng: 8.7800 };

// Un viaje vacío al que colgarle posiciones. No hace falta que sea coherente:
// lo único que se mide aquí es el rastro del conductor dentro del viaje.
async function viajeDesnudo(): Promise<number> {
  return enTransaccion(pool, async (c) => {
    const conductor = await c.query(
      `INSERT INTO conductor (telefono, nombre) VALUES ($1, 'Taxi ETA') RETURNING id`,
      // Del uuid y no de Math.random: con la base de desarrollo llena de
      // taxistas de pruebas, ocho dígitos al azar chocan de vez en cuando y la
      // prueba falla por el teléfono repetido, no por lo que mide.
      [`+2406${BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 12)}`) % 100_000_000n}`.padEnd(13, '0')],
    );
    const dispositivo = await c.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES (gen_random_uuid(), 'cliente') RETURNING id`,
    );
    const zona = await c.query(
      `INSERT INTO zona (nombre, distrito) VALUES ($1, 'Malabo') RETURNING id`,
      [`Zona ETA ${randomUUID()}`],
    );
    const ref = await c.query(
      `INSERT INTO referencia (zona_id, nombre, lat, lng) VALUES ($1, 'Ref ETA', 3.75, 8.78) RETURNING id`,
      [zona.rows[0].id],
    );
    const solicitud = await c.query(
      `INSERT INTO solicitud (dispositivo_cliente_id, telefono_cliente,
                              referencia_origen_id, referencia_destino_id, clave_idempotencia)
       VALUES ($1, '+240222999993', $2, $2, $3) RETURNING id`,
      [dispositivo.rows[0].id, ref.rows[0].id, `eta-${randomUUID()}`],
    );
    const viaje = await c.query(
      `INSERT INTO viaje (solicitud_id, conductor_id, pin) VALUES ($1, $2, '1234') RETURNING id`,
      [solicitud.rows[0].id, conductor.rows[0].id],
    );
    return Number(viaje.rows[0].id);
  });
}

// Puntos del conductor hacia el norte, a la velocidad que se pida.
async function circular(viajeId: number, kmh: number, minutos: number, ahora: Date) {
  const pasos = minutos * 2; // uno cada 30 s, como el latido
  for (let i = 0; i <= pasos; i += 1) {
    const metros = (kmh / 3.6) * i * 30;
    await pool.query(
      `INSERT INTO posicion (viaje_id, actor, lat, lng, creado_en)
       VALUES ($1, 'conductor', $2, 8.78, $3)`,
      [viajeId, 3.75 + metros / 111_320, new Date(ahora.getTime() - (pasos - i) * 30_000)],
    );
  }
}

test('Malabo–Luba deja de dar dos horas y media', async () => {
  const conTabla = await estimarLlegada(pool, MALABO, LUBA);
  assert.ok(
    conTabla.minutos > 35 && conTabla.minutos < 75,
    `un trayecto de unos 40 min no puede dar ${conTabla.minutos}`,
  );
});

test('un trayecto corto dentro de Malabo no cambia: esa parte estaba bien', async () => {
  const corto = await estimarLlegada(pool, MALABO, CERCA);
  // ~1 km de recta, 1,3 de desvío, 18 km/h → unos 4-5 minutos.
  assert.ok(corto.minutos >= 3 && corto.minutos <= 8, `salieron ${corto.minutos} min`);
});

test('sin rastro suficiente no hay velocidad medida: manda la de la tabla', async () => {
  const viajeId = await viajeDesnudo();
  assert.equal(await velocidadRecienteKmh(pool, viajeId), null);
  const e = await llegadaDeViaje(pool, viajeId, MALABO, CERCA);
  assert.equal(e.medida, false);
});

test('la velocidad se mide del recorrido del propio coche', async () => {
  const viajeId = await viajeDesnudo();
  const ahora = new Date();
  await circular(viajeId, 40, 4, ahora);

  const kmh = await velocidadRecienteKmh(pool, viajeId, ahora);
  assert.ok(kmh !== null, 'con cuatro minutos de recorrido hay de sobra');
  assert.ok(Math.abs(kmh! - 40) < 6, `esperaba ~40 km/h y salieron ${kmh}`);
});

test('yendo rápido se llega antes que con la velocidad de la tabla', async () => {
  const lento = await viajeDesnudo();
  const rapido = await viajeDesnudo();
  const ahora = new Date();
  await circular(lento, 10, 4, ahora);
  await circular(rapido, 45, 4, ahora);

  const eLento = await llegadaDeViaje(pool, lento, MALABO, CERCA, ahora);
  const eRapido = await llegadaDeViaje(pool, rapido, MALABO, CERCA, ahora);

  assert.equal(eLento.medida, true);
  assert.equal(eRapido.medida, true);
  assert.ok(
    eRapido.minutos < eLento.minutos,
    `el que va a 45 no puede tardar más que el que va a 10 (${eRapido.minutos} vs ${eLento.minutos})`,
  );
});

test('un coche parado no da tiempos de horas: hay suelo', async () => {
  const viajeId = await viajeDesnudo();
  const ahora = new Date();
  // Ocho minutos temblando en el mismo sitio, que es lo que hace un GPS parado.
  for (let i = 0; i <= 16; i += 1) {
    await pool.query(
      `INSERT INTO posicion (viaje_id, actor, lat, lng, creado_en)
       VALUES ($1, 'conductor', $2, $3, $4)`,
      [viajeId, 3.75 + (i % 2) * 0.0001, 8.78 + (i % 3) * 0.0001,
        new Date(ahora.getTime() - (16 - i) * 30_000)],
    );
  }
  // No se ha movido: no hay velocidad que medir, no que sea cero.
  assert.equal(await velocidadRecienteKmh(pool, viajeId, ahora), null);
});

test('una fijación disparada no acelera el coche', async () => {
  const viajeId = await viajeDesnudo();
  const ahora = new Date();
  await circular(viajeId, 25, 4, ahora);
  // Y un salto de veinte kilómetros en medio minuto.
  await pool.query(
    `INSERT INTO posicion (viaje_id, actor, lat, lng, creado_en)
     VALUES ($1, 'conductor', 3.95, 8.78, $2)`,
    [viajeId, new Date(ahora.getTime() - 15_000)],
  );
  const kmh = await velocidadRecienteKmh(pool, viajeId, ahora);
  assert.ok(kmh !== null && kmh < 60, `la fijación no puede contar; salieron ${kmh}`);
});

// --- 20/09: el tiempo deja de empezar siempre en el mismo número ---

// El rastro del TURNO del conductor de un viaje: lo que manda el móvil cada
// quince segundos mientras está en servicio, exista o no un viaje.
async function rastroDelTurno(viajeId: number, kmh: number, minutos: number, ahora: Date) {
  const dueno = await pool.query('SELECT conductor_id FROM viaje WHERE id = $1', [viajeId]);
  const conductorId = Number(dueno.rows[0].conductor_id);
  const pasos = minutos * 4; // uno cada 15 s
  for (let i = 0; i <= pasos; i += 1) {
    const metros = (kmh / 3.6) * i * 15;
    await pool.query(
      `INSERT INTO rastro (conductor_id, lat, lng, creado_en)
       VALUES ($1, $2, 8.78, $3)`,
      [conductorId, 3.75 + metros / 111_320, new Date(ahora.getTime() - (pasos - i) * 15_000)],
    );
  }
}

test('al empezar el viaje, la velocidad sale del turno y no de la tabla', async () => {
  // Este es el «siempre pone diecisiete minutos»: viaje recién aceptado, sin
  // ninguna posición propia todavía, pero con el taxista llevando rato
  // circulando. Antes caía en los 18 km/h de la tabla y el número salía
  // clavado para todo el mundo.
  const viajeId = await viajeDesnudo();
  const ahora = new Date();
  await rastroDelTurno(viajeId, 45, 5, ahora);

  assert.equal(await velocidadRecienteKmh(pool, viajeId, ahora), null,
    'del viaje no hay nada que medir: acaba de empezar');
  const e = await llegadaDeViaje(pool, viajeId, MALABO, CERCA, ahora);
  assert.equal(e.medida, true, 'el turno sí tenía rastro');
  assert.ok(e.velocidadUsadaKmh > 30,
    `iba a 45 km/h y la estimación usó ${e.velocidadUsadaKmh}`);
});

test('dos taxistas con la misma distancia y distinta marcha no dan el mismo tiempo', async () => {
  const atascado = await viajeDesnudo();
  const suelto = await viajeDesnudo();
  const ahora = new Date();
  await rastroDelTurno(atascado, 9, 5, ahora);
  await rastroDelTurno(suelto, 45, 5, ahora);

  const lento = await llegadaDeViaje(pool, atascado, MALABO, CERCA, ahora);
  const rapido = await llegadaDeViaje(pool, suelto, MALABO, CERCA, ahora);
  assert.ok(lento.minutos > rapido.minutos,
    `el atascado tiene que tardar más (${lento.minutos} vs ${rapido.minutos})`);
});

// Dos puntos SOBRE calle de Malabo, sacados del propio plano: MALABO y CERCA
// están a ojo de mapa y caen fuera de la calzada, que es justo lo que este
// caso no puede tener.
const EN_CALLE_A = { lat: 3.75299, lng: 8.76699 };
const EN_CALLE_B = { lat: 3.75278, lng: 8.78346 };

test('la distancia que se anuncia es la de las calles, no la recta por 1,3', async () => {
  const e = await estimarLlegada(pool, EN_CALLE_A, EN_CALLE_B);
  const recta = distanciaMetros(EN_CALLE_A.lat, EN_CALLE_A.lng, EN_CALLE_B.lat, EN_CALLE_B.lng);
  const porCalles = rutaParaLlegar(EN_CALLE_A, EN_CALLE_B);
  assert.ok(porCalles !== null, 'este par está dentro del plano de Malabo');
  assert.equal(e.distanciaM, Math.round(porCalles!.distanciaM));
  assert.ok(e.distanciaM >= Math.round(recta),
    'por calles nunca se anda menos que en línea recta');
});
