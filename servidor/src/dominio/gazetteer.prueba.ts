// Batería de aceptación del paso 4. Requiere la base de datos de desarrollo
// arrancada (npm run bd:dev), migrada y con la semilla cargada.
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import {
  anadirAlias, buscarReferencias, crearZona, editarReferencia,
  guardarReferencia, quitarAlias, referenciasMasUsadas, registrarUso,
} from './gazetteer.js';
import { crearSolicitud } from './transiciones.js';

let pool: pg.Pool;

before(async () => {
  pool = crearPool();
  const referencias = await pool.query('SELECT count(*)::int AS n FROM referencia');
  assert.ok(referencias.rows[0].n >= 20, 'Faltan referencias: carga la semilla (npm run bd:semilla)');
});

after(async () => {
  await pool.end();
});

async function crearZonaPrueba(): Promise<number> {
  const resultado = await enTransaccion(pool, (c) =>
    crearZona(c, `Zona Prueba ${randomUUID()}`, 3.75, 8.78));
  return resultado.zonaId;
}

// ACEPTACIÓN del paso 4: un alias mal escrito devuelve la referencia correcta
// entre los 3 primeros resultados.
const CASOS_ACEPTACION: Array<[string, string]> = [
  ['mercao semu', 'Mercado SEMU'],
  ['iglesia ngema', 'Iglesia de Ela Nguema'],
  ['hospita jeneral', 'Hospital General de Malabo'],
  ['la catedrál', 'Catedral de Santa Isabel'],
];

for (const [malEscrito, esperado] of CASOS_ACEPTACION) {
  test(`ACEPTACIÓN: «${malEscrito}» encuentra «${esperado}» entre los 3 primeros`, async () => {
    const resultados = await buscarReferencias(pool, malEscrito, { limite: 3 });
    assert.ok(
      resultados.some((r) => r.nombre === esperado),
      `«${esperado}» no está en el top 3 de «${malEscrito}»: `
      + resultados.map((r) => r.nombre).join(', '),
    );
  });
}

test('el contador de uso reordena: entre parecidos, lo más pedido sube', async () => {
  const zonaId = await crearZonaPrueba();
  await enTransaccion(pool, async (c) => {
    await guardarReferencia(c, { zonaId, nombre: 'Bar Central Uno', lat: 3.75, lng: 8.78 });
    await guardarReferencia(c, { zonaId, nombre: 'Bar Central Dos', lat: 3.751, lng: 8.781 });
  });

  const dos = await buscarReferencias(pool, 'bar central', { zonaId });
  const idDos = dos.find((r) => r.nombre === 'Bar Central Dos')!.id;
  for (let i = 0; i < 3; i += 1) {
    await enTransaccion(pool, (c) => registrarUso(c, idDos));
  }

  const reordenados = await buscarReferencias(pool, 'bar central', { zonaId });
  assert.equal(reordenados[0].nombre, 'Bar Central Dos');
});

test('crear una solicitud sube el contador de origen y destino; el reintento no', async () => {
  const zonaId = await crearZonaPrueba();
  const { origenId, destinoId } = await enTransaccion(pool, async (c) => {
    const origen = await guardarReferencia(c, { zonaId, nombre: 'Origen Contador', lat: 3.75, lng: 8.78 });
    const destino = await guardarReferencia(c, { zonaId, nombre: 'Destino Contador', lat: 3.76, lng: 8.79 });
    return { origenId: origen.referenciaId, destinoId: destino.referenciaId };
  });
  const dispositivo = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES (gen_random_uuid(), 'cliente') RETURNING id`,
  );

  const datos = {
    dispositivoClienteId: dispositivo.rows[0].id as number,
    telefonoCliente: '+240222999995',
    referenciaOrigenId: origenId,
    referenciaDestinoId: destinoId,
    actor: 'cliente' as const,
    claveIdempotencia: `contador-${randomUUID()}`,
  };
  await enTransaccion(pool, (c) => crearSolicitud(c, datos));
  await enTransaccion(pool, (c) => crearSolicitud(c, datos)); // reintento idempotente

  const usos = await pool.query(
    'SELECT id, veces_usada::int AS usos FROM referencia WHERE id IN ($1, $2)',
    [origenId, destinoId],
  );
  for (const fila of usos.rows) {
    assert.equal(fila.usos, 1, `la referencia ${fila.id} debe tener exactamente 1 uso`);
  }
});

test('respaldo de R1: las más usadas de la zona, en orden de uso', async () => {
  const zonaId = await crearZonaPrueba();
  await enTransaccion(pool, async (c) => {
    for (const [nombre, usos] of [['Poco Pedida', 1], ['Muy Pedida', 9], ['Media', 4]] as const) {
      const ref = await guardarReferencia(c, { zonaId, nombre, lat: 3.75, lng: 8.78 });
      for (let i = 0; i < usos; i += 1) {
        await registrarUso(c, ref.referenciaId);
      }
    }
  });
  const top = await referenciasMasUsadas(pool, zonaId, 5);
  assert.deepEqual(top.map((r) => r.nombre), ['Muy Pedida', 'Media', 'Poco Pedida']);
});

test('una referencia desactivada desaparece de la búsqueda; activada, vuelve', async () => {
  const zonaId = await crearZonaPrueba();
  const ref = await enTransaccion(pool, (c) =>
    guardarReferencia(c, { zonaId, nombre: 'Quiosco Fantasma', lat: 3.75, lng: 8.78 }));

  await enTransaccion(pool, (c) => editarReferencia(c, ref.referenciaId, { activa: false }));
  const sinElla = await buscarReferencias(pool, 'quiosco fantasma', { zonaId });
  assert.equal(sinElla.length, 0);

  await enTransaccion(pool, (c) => editarReferencia(c, ref.referenciaId, { activa: true }));
  const conElla = await buscarReferencias(pool, 'quiosco fantasma', { zonaId });
  assert.equal(conElla[0]?.nombre, 'Quiosco Fantasma');
});

test('guardarReferencia es upsert por (zona, nombre): actualiza coordenadas y acumula alias', async () => {
  const zonaId = await crearZonaPrueba();
  const primera = await enTransaccion(pool, (c) => guardarReferencia(c, {
    zonaId, nombre: 'Tienda Esquina', lat: 3.75, lng: 8.78, alias: ['la esquina'],
  }));
  const segunda = await enTransaccion(pool, (c) => guardarReferencia(c, {
    zonaId, nombre: 'Tienda Esquina', lat: 3.7501, lng: 8.7801, alias: ['donde Paco'],
  }));
  assert.equal(primera.creada, true);
  assert.equal(segunda.creada, false);
  assert.equal(segunda.referenciaId, primera.referenciaId);

  const alias = await pool.query(
    'SELECT alias FROM referencia_alias WHERE referencia_id = $1 ORDER BY alias',
    [primera.referenciaId],
  );
  assert.deepEqual(alias.rows.map((f) => f.alias), ['donde Paco', 'la esquina']);
});

test('alias: añadir es idempotente y quitar uno inexistente es error ruidoso', async () => {
  const zonaId = await crearZonaPrueba();
  const ref = await enTransaccion(pool, (c) =>
    guardarReferencia(c, { zonaId, nombre: 'Peluquería Marta', lat: 3.75, lng: 8.78 }));

  await enTransaccion(pool, (c) => anadirAlias(c, ref.referenciaId, 'donde marta'));
  await enTransaccion(pool, (c) => anadirAlias(c, ref.referenciaId, 'donde marta'));
  await enTransaccion(pool, (c) => quitarAlias(c, ref.referenciaId, 'donde marta'));
  await assert.rejects(
    enTransaccion(pool, (c) => quitarAlias(c, ref.referenciaId, 'donde marta')),
    /no tiene el alias/,
  );
});

test('texto de búsqueda demasiado corto: error explícito', async () => {
  await assert.rejects(buscarReferencias(pool, ' a '), /demasiado corto/);
});
