// El tiempo de llegada con la velocidad real del coche (migración 053).
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import {
  estimarLlegada, factorDeMarchaDelTurno, llegadaDeViaje, velocidadRecienteKmh,
} from './llegada.js';
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

  // Desde la migración 073 lo que distingue a los dos no es la media de
  // kilómetros por hora —que se hundía con cada espera— sino el factor medido
  // EN MARCHA contra lo que supone el plano. El resultado que importa es el
  // mismo y por eso la prueba sigue: el que va a 45 no puede tardar más que el
  // que va a 10.
  assert.ok(
    eRapido.minutos <= eLento.minutos,
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
  // Y del TURNO sí hay: ese era el arreglo del «siempre pone diecisiete
  // minutos». Desde la migración 073 lo que se saca del turno es el factor en
  // marcha, y este rastro de prueba no va por calles del plano, así que no hay
  // con qué comparar y manda el plano tal cual. Lo que se comprueba aquí es lo
  // de siempre: que el tiempo sale y es razonable, no una constante.
  const e = await llegadaDeViaje(pool, viajeId, MALABO, CERCA, ahora);
  assert.ok(e.minutos > 0 && e.minutos < 60, `tiempo razonable, salió ${e.minutos}`);
  assert.ok(e.velocidadUsadaKmh > 10,
    `la velocidad que usa el cálculo no puede ser de coche parado (${e.velocidadUsadaKmh})`);
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

// --- Migración 073: el tiempo sale del plano, no de una velocidad media -----

// Rastro de un taxi que conduce y LUEGO ESPERA parado. Es el caso de verdad:
// el tiempo hasta destino se calcula justo cuando el pasajero se sube, o sea
// justo después de que el taxi haya estado parado esperándole. Esa espera cae
// dentro de la ventana de seis minutos y hundía la media.
async function conduceYLuegoEspera(
  viajeId: number, kmh: number, minutosEnMarcha: number, minutosParado: number, ahora: Date,
) {
  const dueno = await pool.query('SELECT conductor_id FROM viaje WHERE id = $1', [viajeId]);
  const conductorId = Number(dueno.rows[0].conductor_id);
  const total = (minutosEnMarcha + minutosParado) * 4; // un punto cada 15 s
  const hastaMarcha = minutosEnMarcha * 4;
  let metros = 0;
  // Por una calle DE VERDAD del plano: el factor compara con lo que el grafo
  // dice de esas calles, así que un rastro por el monte no se puede comparar
  // con nada y no cuenta como marcha. En un viaje real los puntos caen en la
  // calzada, que es de lo que se trata.
  const largoM = 1800; // lo que mide el corredor EN_CALLE_A → EN_CALLE_B
  for (let i = 0; i <= total; i += 1) {
    if (i <= hastaMarcha) metros += (kmh / 3.6) * 15;
    const avance = Math.min(1, metros / largoM);
    await pool.query(
      `INSERT INTO rastro (conductor_id, lat, lng, creado_en)
       VALUES ($1, $2, $3, $4)`,
      [
        conductorId,
        EN_CALLE_A.lat + (EN_CALLE_B.lat - EN_CALLE_A.lat) * avance,
        EN_CALLE_A.lng + (EN_CALLE_B.lng - EN_CALLE_A.lng) * avance,
        new Date(ahora.getTime() - (total - i) * 15_000),
      ],
    );
  }
}

test('esperar en la parada ya no le alarga el viaje al pasajero', async () => {
  // EL CASO DE VERDAD (28/09): 7 km marcados en 35 minutos que se hicieron en
  // 15. El taxista había estado parado esperando, y esa espera entraba en «la
  // velocidad a la que va»: diez minutos parado y cinco a 30 km/h dan una
  // media de 10 km/h, y con eso se estimaba el viaje entero.
  const viajeId = await viajeDesnudo();
  const ahora = new Date();
  // Tres minutos rodando a 30 y tres parado esperando al pasajero: es la foto
  // exacta del momento en que se calcula el tiempo.
  await conduceYLuegoEspera(viajeId, 30, 3, 3, ahora);

  // La velocidad del turno ya NO cuenta la espera larga: condujo a 30 km/h y
  // eso es lo que tiene que salir, no la media con los tres minutos parado
  // dentro. Con la media vieja salían 15 km/h, y de ahí los 39 minutos para
  // 6,5 km que se vieron en producción.
  const { velocidadDelTurnoKmh } = await import('./llegada.js');
  const conductorId = await conductorDelViaje(viajeId);
  const medida = await velocidadDelTurnoKmh(pool, conductorId, ahora);
  assert.ok(medida !== null && medida > 22,
    `condujo a 30 km/h; con la espera fuera tiene que salir parecido, salió ${medida}`);

  // Y el tiempo que se anuncia va acorde: nada de multiplicar por dos por
  // haber estado esperando en la parada.
  const e = await llegadaDeViaje(pool, viajeId, EN_CALLE_A, EN_CALLE_B, ahora);
  assert.ok(e.velocidadUsadaKmh > 22,
    `la velocidad del cálculo tiene que ser de coche en marcha (${e.velocidadUsadaKmh})`);
});

test('el factor solo cuenta el tiempo en marcha', async () => {
  const parado = await viajeDesnudo();
  const ahora = new Date();
  // Veinte minutos sin moverse: no hay marcha que medir, así que no hay factor
  // y manda el plano tal cual. Lo contrario —inventarse un factor de coche
  // parado— es lo que daba los 35 minutos.
  await conduceYLuegoEspera(parado, 0, 0, 20, ahora);
  const factor = await factorDeMarchaDelTurno(pool, await conductorDelViaje(parado), ahora);
  assert.equal(factor, null, 'un coche que no se ha movido no tiene factor');
});

test('con el interruptor del plano encendido, el tiempo es el del plano más la holgura', async () => {
  // Apagado desde la migración 074: medido en producción, ese camino se
  // pasaba de largo ocho minutos de media. El código se queda y se prueba,
  // porque el interruptor permite volver a intentarlo con otra holgura el día
  // que haya una razón medida para hacerlo.
  const previo = await pool.query(`SELECT valor FROM parametro WHERE clave = 'eta_usa_plano'`);
  await pool.query(`UPDATE parametro SET valor = '1' WHERE clave = 'eta_usa_plano'`);
  try {
    const e = await estimarLlegada(pool, EN_CALLE_A, EN_CALLE_B);
    const porCalles = rutaParaLlegar(EN_CALLE_A, EN_CALLE_B);
    assert.ok(porCalles !== null);
    const holgura = 1.15;
    const esperado = Math.max(1, Math.round((porCalles!.segundosTipicos * holgura) / 60));
    assert.equal(e.minutos, esperado,
      'el plano dice el tiempo de esas calles y se le suma la holgura, nada más');
  } finally {
    await pool.query(
      `UPDATE parametro SET valor = $1 WHERE clave = 'eta_usa_plano'`,
      [previo.rows[0]?.valor ?? '0'],
    );
  }
});

test('la espera larga no cuenta, la parada corta sí', async () => {
  // La diferencia que sostiene todo esto: un semáforo es conducir y entra en
  // la cuenta; esperar en la parada del mercado, no.
  const corta = await viajeDesnudo();
  const larga = await viajeDesnudo();
  const ahora = new Date();
  await conduceYLuegoEspera(corta, 30, 3, 1, ahora);   // un minuto parado
  await conduceYLuegoEspera(larga, 30, 3, 10, ahora);  // diez minutos parado

  const { velocidadDelTurnoKmh } = await import('./llegada.js');
  const conCorta = await velocidadDelTurnoKmh(pool, await conductorDelViaje(corta), ahora);
  const conLarga = await velocidadDelTurnoKmh(pool, await conductorDelViaje(larga), ahora);

  // Con una parada corta se mide, y sale la velocidad a la que conducía: el
  // minuto parado es tráfico y cuenta, pero no hunde nada.
  assert.ok(conCorta !== null && conCorta > 22,
    `condujo a 30 km/h y salió ${conCorta}`);

  // Con diez minutos parado NO se mide nada: la ventana son seis minutos y en
  // esos seis el coche no se movió. Y eso es justo lo que se quería — antes
  // salía un número bajísimo que se anunciaba como si fuera verdad, y de ahí
  // los 39 minutos para 6,5 km. Sin medida manda la velocidad de la tabla,
  // que al menos no finge saber algo que nadie ha medido.
  assert.equal(conLarga, null,
    'un coche que lleva la ventana entera parado no tiene velocidad que medir');
});

async function conductorDelViaje(viajeId: number): Promise<number> {
  const res = await pool.query('SELECT conductor_id FROM viaje WHERE id = $1', [viajeId]);
  return Number(res.rows[0].conductor_id);
}
