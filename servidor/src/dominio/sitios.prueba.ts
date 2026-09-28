// Los sitios que pone la gente (migración 072).
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { crearZona, guardarReferencia, buscarReferencias } from './gazetteer.js';
import { clave, normalizar, proponerSitio, publicarSiSeUsa } from './sitios.js';

let pool: pg.Pool;
let dispositivoId: number;
let otroDispositivoId: number;

before(async () => {
  pool = crearPool();
  const uno = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES ($1, 'cliente') RETURNING id`,
    [randomUUID()],
  );
  dispositivoId = Number(uno.rows[0].id);
  const dos = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES ($1, 'cliente') RETURNING id`,
    [randomUUID()],
  );
  otroDispositivoId = Number(dos.rows[0].id);
});

after(async () => {
  await pool.end();
});

// --- Lo que no necesita base de datos --------------------------------------

test('el nombre se normaliza para comparar, no para guardar', () => {
  assert.equal(normalizar('Avenida  de la  Independencia.'), 'avenida de la independencia');
  assert.equal(normalizar('MERCADO SEMÚ'), 'mercado semu');
  assert.equal(normalizar('Calle Rey Boncoro, 12'), 'calle rey boncoro 12');
});

test('las palabras de relleno no distinguen un sitio de otro', () => {
  // Lo que la gente escribe de cuatro maneras y es el mismo sitio.
  assert.equal(clave('Avenida de la Independencia'), clave('avenida independencia'));
  assert.equal(clave('Calle Rey Boncoro'), clave('C/ Rey Boncoro'));
  // Y lo que NO es el mismo sitio, aunque se parezca.
  assert.notEqual(clave('Calle 3'), clave('Calle 8'));
  assert.notEqual(clave('Mercado Central'), clave('Mercado Semu'));
});

// --- Con base de datos ------------------------------------------------------

async function zonaNueva(lat = 3.75, lng = 8.78): Promise<number> {
  return enTransaccion(pool, async (c) => {
    const { zonaId } = await crearZona(c, `Zona Sitios ${randomUUID()}`, lat, lng);
    return zonaId;
  });
}

test('un sitio que no está se crea, y sirve para pedir el taxi', async () => {
  const zonaId = await zonaNueva();
  const sitio = await enTransaccion(pool, (c) => proponerSitio(c, {
    nombre: 'Calle del Rey Boncoro',
    lat: 3.7502, lng: 8.7801, zonaId, dispositivoId,
  }));
  assert.equal(sitio.creada, true);

  const fila = await pool.query(
    'SELECT nombre, propuesta_en, aprobada_en, propuesta_por_dispositivo_id FROM referencia WHERE id = $1',
    [sitio.referenciaId],
  );
  assert.equal(fila.rows[0].nombre, 'Calle del Rey Boncoro', 'se guarda con SUS palabras');
  assert.ok(fila.rows[0].propuesta_en !== null, 'nace como propuesta');
  assert.equal(fila.rows[0].aprobada_en, null, 'y sin aprobar');
  assert.equal(Number(fila.rows[0].propuesta_por_dispositivo_id), dispositivoId);
});

test('el mismo sitio escrito de otra manera no se duplica', async () => {
  const zonaId = await zonaNueva(3.76, 8.79);
  const primero = await enTransaccion(pool, (c) => proponerSitio(c, {
    nombre: 'Avenida de la Independencia', lat: 3.7601, lng: 8.7901, zonaId, dispositivoId,
  }));
  // Otra persona, otro día, cincuenta metros más allá y con otras palabras.
  const segundo = await enTransaccion(pool, (c) => proponerSitio(c, {
    nombre: 'avenida independencia', lat: 3.7605, lng: 8.7901, zonaId,
    dispositivoId: otroDispositivoId,
  }));
  assert.equal(segundo.creada, false, 'es el mismo sitio con otra letra');
  assert.equal(segundo.referenciaId, primero.referenciaId);
});

test('el mismo nombre lejos SÍ es otro sitio: hay dos «Mercado» en Malabo', async () => {
  const zonaId = await zonaNueva(3.77, 8.80);
  const uno = await enTransaccion(pool, (c) => proponerSitio(c, {
    nombre: 'Mercado del barrio', lat: 3.7700, lng: 8.8000, zonaId, dispositivoId,
  }));
  // Un kilómetro más allá: mismo nombre, otro sitio.
  const dos = await enTransaccion(pool, (c) => proponerSitio(c, {
    nombre: 'Mercado del barrio nuevo', lat: 3.7790, lng: 8.8000, zonaId, dispositivoId,
  }));
  assert.notEqual(dos.referenciaId, uno.referenciaId);
});

test('un nombre de dos letras no entra', async () => {
  const zonaId = await zonaNueva(3.78, 8.81);
  await assert.rejects(
    () => enTransaccion(pool, (c) => proponerSitio(c, {
      nombre: 'ab', lat: 3.78, lng: 8.81, zonaId, dispositivoId,
    })),
    /demasiado corto/,
  );
});

test('lo propuesto solo lo ve quien lo puso, hasta que se usa', async () => {
  const zonaId = await zonaNueva(3.79, 8.82);
  const nombre = `Casa de Nchama ${Math.floor(Math.random() * 100000)}`;
  const sitio = await enTransaccion(pool, (c) => proponerSitio(c, {
    nombre, lat: 3.7901, lng: 8.8201, zonaId, dispositivoId,
  }));

  const suyo = await buscarReferencias(pool, nombre, { dispositivoId });
  assert.ok(
    suyo.some((r) => Number(r.id) === Number(sitio.referenciaId)),
    `quien lo puso lo encuentra (buscó «${nombre}» y salió ${JSON.stringify(suyo.map((r) => r.nombre))})`,
  );

  const ajeno = await buscarReferencias(pool, nombre, {
    dispositivoId: otroDispositivoId,
  });
  assert.equal(ajeno.some((r) => Number(r.id) === Number(sitio.referenciaId)), false,
    'los demás todavía no: el buscador no se llena de nombres sin confirmar');

  // Tres viajes a ese nombre y deja de estar en cuarentena. No hace falta que
  // nadie lo apruebe: que la gente lo use ES la aprobación.
  await pool.query('UPDATE referencia SET veces_usada = 3 WHERE id = $1', [sitio.referenciaId]);
  const publicado = await enTransaccion(pool, (c) => publicarSiSeUsa(c, sitio.referenciaId));
  assert.equal(publicado, true);

  const ahoraSi = await buscarReferencias(pool, nombre, {
    dispositivoId: otroDispositivoId,
  });
  assert.ok(ahoraSi.some((r) => Number(r.id) === Number(sitio.referenciaId)),
    'ahora lo ve todo el mundo');
});

test('un sitio del catálogo de siempre no necesita que nadie lo apruebe', async () => {
  const zonaId = await zonaNueva(3.74, 8.77);
  const nombre = `Hospital de prueba ${Math.floor(Math.random() * 100000)}`;
  const { referenciaId } = await enTransaccion(pool, (c) => guardarReferencia(c, {
    zonaId, nombre, lat: 3.7401, lng: 8.7701,
  }));
  const ajeno = await buscarReferencias(pool, nombre, {
    dispositivoId: otroDispositivoId,
  });
  assert.ok(ajeno.some((r) => Number(r.id) === Number(referenciaId)));
});
