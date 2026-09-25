// Batería del precio declarado y las bandas (migración 066).
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { crearZona, guardarReferencia } from './gazetteer.js';
import { leerParametroEntero } from './parametros.js';
import {
  bandaDeLosPrecios, declararPrecio, percentil, recalcularBandaDe, senalesDeTarifa,
} from './precios.js';
import { valorarViaje } from './reputacion.js';

let pool: pg.Pool;
let dispositivoClienteId: number;

before(async () => {
  pool = crearPool();
  const dispositivo = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES ($1, 'cliente') RETURNING id`,
    [randomUUID()],
  );
  dispositivoClienteId = Number(dispositivo.rows[0].id);
});

after(async () => {
  await pool.end();
});

let siguienteTelefono = Math.floor(Math.random() * 100_000_000);
function telefonoUnico(): string {
  siguienteTelefono = (siguienteTelefono + 1) % 100_000_000;
  return `+2406${String(siguienteTelefono).padStart(8, '0')}`;
}

interface Escenario {
  zonaOrigen: number;
  zonaDestino: number;
  refOrigen: number;
  refDestino: number;
}

// Zonas propias por prueba: las bandas viven por par de zonas, y dos pruebas
// compartiendo par se pisarían los percentiles.
async function montarEscenario(): Promise<Escenario> {
  return enTransaccion(pool, async (c) => {
    const zonaOrigen = (await crearZona(c, `Zona Precio A ${randomUUID()}`, 3.75, 8.78)).zonaId;
    const zonaDestino = (await crearZona(c, `Zona Precio B ${randomUUID()}`, 3.76, 8.79)).zonaId;
    return {
      zonaOrigen,
      zonaDestino,
      refOrigen: (await guardarReferencia(c, {
        zonaId: zonaOrigen, nombre: 'Origen Precio', lat: 3.75, lng: 8.78,
      })).referenciaId,
      refDestino: (await guardarReferencia(c, {
        zonaId: zonaDestino, nombre: 'Destino Precio', lat: 3.76, lng: 8.79,
      })).referenciaId,
    };
  });
}

async function crearConductor(): Promise<number> {
  const res = await pool.query(
    `INSERT INTO conductor (telefono, nombre, estado_verificacion)
     VALUES ($1, 'Taxi Precio', 'verificado') RETURNING id`,
    [telefonoUnico()],
  );
  return Number(res.rows[0].id);
}

// Un viaje terminado de esa ruta, listo para que le pongan precio y nota.
async function viajeHecho(escenario: Escenario, conductorId: number): Promise<number> {
  const solicitud = await pool.query(
    `INSERT INTO solicitud
       (dispositivo_cliente_id, telefono_cliente, referencia_origen_id,
        referencia_destino_id, clave_idempotencia, estado, conductor_id)
     VALUES ($1, '+240222999996', $2, $3, $4, 'COMPLETADO', $5)
     RETURNING id`,
    [dispositivoClienteId, escenario.refOrigen, escenario.refDestino, `precio-${randomUUID()}`, conductorId],
  );
  const viaje = await pool.query(
    `INSERT INTO viaje (solicitud_id, conductor_id, pin) VALUES ($1, $2, '1234') RETURNING id`,
    [solicitud.rows[0].id, conductorId],
  );
  return Number(viaje.rows[0].id);
}

const bandaDe = async (escenario: Escenario) => {
  const res = await pool.query(
    `SELECT p25, p50, p75, muestras FROM banda_precio
     WHERE zona_origen_id = $1 AND zona_destino_id = $2`,
    [escenario.zonaOrigen, escenario.zonaDestino],
  );
  if (res.rowCount === 0) return null;
  const f = res.rows[0];
  return {
    p25: Number(f.p25), p50: Number(f.p50), p75: Number(f.p75), muestras: f.muestras,
  };
};

// --- Lo que no necesita base de datos --------------------------------------

test('los percentiles salen del sitio que toca, sin interpolar', () => {
  // Cinco valores, índices 0..4: el p25 es el segundo, no el del medio.
  const cinco = [1000, 1500, 2000, 2500, 3000];
  assert.equal(percentil(cinco, 0.25), 1500);
  assert.equal(percentil(cinco, 0.5), 2000);
  assert.equal(percentil(cinco, 0.75), 2500);
  // Un solo valor es los tres percentiles: no hay dispersión que describir.
  assert.deepEqual(bandaDeLosPrecios([1500]), { p25: 1500, p50: 1500, p75: 1500, muestras: 1 });
  assert.equal(bandaDeLosPrecios([]), null);
});

test('la banda ordena sola: da igual en qué orden lleguen las respuestas', () => {
  const a = bandaDeLosPrecios([3000, 1000, 2000, 1500, 2500]);
  const b = bandaDeLosPrecios([1000, 1500, 2000, 2500, 3000]);
  assert.deepEqual(a, b);
  assert.ok(a!.p25 <= a!.p50 && a!.p50 <= a!.p75, 'la banda sale ordenada, que es lo que exige el CHECK');
});

// --- Con base de datos ------------------------------------------------------

test('con pocas respuestas no se toca la banda del operador', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductor();
  // La del operador: escrita a mano, `muestras` a 0.
  await pool.query(
    `INSERT INTO banda_precio (zona_origen_id, zona_destino_id, p25, p50, p75)
     VALUES ($1, $2, 1000, 1500, 2000)`,
    [escenario.zonaOrigen, escenario.zonaDestino],
  );

  const minimas = await leerParametroEntero(pool, 'banda_muestras_minimas');
  for (let i = 0; i < minimas - 1; i += 1) {
    const viajeId = await viajeHecho(escenario, conductorId);
    await enTransaccion(pool, async (c) => {
      await declararPrecio(c, viajeId, 'cliente', 9000);
      await recalcularBandaDe(c, viajeId);
    });
  }

  // Su criterio de campo vale más que cuatro cifras sueltas.
  assert.deepEqual(await bandaDe(escenario), { p25: 1000, p50: 1500, p75: 2000, muestras: 0 });
});

test('con respuestas suficientes, la banda es lo que la gente dice que paga', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductor();
  await pool.query(
    `INSERT INTO banda_precio (zona_origen_id, zona_destino_id, p25, p50, p75)
     VALUES ($1, $2, 500, 600, 700)`,
    [escenario.zonaOrigen, escenario.zonaDestino],
  );

  for (const importe of [1000, 1500, 2000, 2500, 3000]) {
    const viajeId = await viajeHecho(escenario, conductorId);
    await enTransaccion(pool, async (c) => {
      await declararPrecio(c, viajeId, 'cliente', importe);
      await recalcularBandaDe(c, viajeId);
    });
  }

  const banda = await bandaDe(escenario);
  assert.equal(banda!.muestras, 5, 'y queda a la vista que ya no la escribió nadie a mano');
  assert.deepEqual([banda!.p25, banda!.p50, banda!.p75], [1500, 2000, 2500]);
});

test('declarar dos veces el mismo viaje no cuenta dos veces', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductor();
  const viajeId = await viajeHecho(escenario, conductorId);

  const primera = await enTransaccion(pool, (c) => declararPrecio(c, viajeId, 'cliente', 2000));
  const segunda = await enTransaccion(pool, (c) => declararPrecio(c, viajeId, 'cliente', 9000));
  assert.equal(primera.guardado, true);
  assert.equal(segunda.guardado, false, 'la cifra no se cambia a base de reenviar');

  const filas = await pool.query(
    'SELECT importe_xaf FROM precio_declarado WHERE viaje_id = $1', [viajeId],
  );
  assert.equal(filas.rowCount, 1);
  assert.equal(Number(filas.rows[0].importe_xaf), 2000);
});

test('un importe imposible no entra', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductor();
  const viajeId = await viajeHecho(escenario, conductorId);
  await assert.rejects(
    () => enTransaccion(pool, (c) => declararPrecio(c, viajeId, 'cliente', -100)),
    /Importe no válido/,
  );
  await assert.rejects(
    () => enTransaccion(pool, (c) => declararPrecio(c, viajeId, 'cliente', 5_000_000)),
    /Importe no válido/,
  );
});

test('el taxista marcado varias veces por cobrar de más sale en la lista del operador', async () => {
  const escenario = await montarEscenario();
  const señalado = await crearConductor();
  const tranquilo = await crearConductor();
  const minimo = await leerParametroEntero(pool, 'alarma_cobros_de_mas');

  for (let i = 0; i < minimo; i += 1) {
    const viajeId = await viajeHecho(escenario, señalado);
    await enTransaccion(pool, (c) => valorarViaje(c, viajeId, 'cliente', {
      puntuacion: 2, cobroDeMas: true,
    }));
  }
  // Al otro le marcan una sola vez: una queja no es un patrón, y una lista
  // que señala a cualquiera con una queja no la lee nadie.
  const suelto = await viajeHecho(escenario, tranquilo);
  await enTransaccion(pool, (c) => valorarViaje(c, suelto, 'cliente', {
    puntuacion: 3, cobroDeMas: true,
  }));

  const senales = await senalesDeTarifa(pool);
  const mio = senales.find((s) => s.conductorId === señalado);
  assert.ok(mio, 'el marcado varias veces tiene que salir');
  assert.equal(mio!.marcas, minimo);
  assert.equal(senales.some((s) => s.conductorId === tranquilo), false);
});

test('la nota normal no marca nada: hay que marcarlo a propósito', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductor();
  const viajeId = await viajeHecho(escenario, conductorId);
  await enTransaccion(pool, (c) => valorarViaje(c, viajeId, 'cliente', { puntuacion: 1 }));
  const marcado = await pool.query(
    'SELECT cobro_de_mas FROM valoracion WHERE viaje_id = $1', [viajeId],
  );
  assert.equal(marcado.rows[0].cobro_de_mas, false,
    'una mala nota es una mala nota, no una acusación de cobrar de más');
});
