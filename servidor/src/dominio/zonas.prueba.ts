// Pruebas de situar barrios sobre el terreno (migración 025).
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { crearZonaEnGps, situarZona } from './zonas.js';

let pool: pg.Pool;

before(() => {
  pool = crearPool();
});

after(async () => {
  await pool.end();
});

// Coordenadas dentro de Malabo, separadas unos cientos de metros.
const MALABO = { lat: 3.7531, lng: 8.7752 };
const cerca = (metros: number) => ({
  lat: MALABO.lat + metros / 111_320,
  lng: MALABO.lng,
});

async function vecinasDe(zonaId: number): Promise<number> {
  const r = await pool.query(
    'SELECT count(*)::int AS n FROM zona_adyacencia WHERE zona_id = $1',
    [zonaId],
  );
  return r.rows[0].n;
}

test('situar un barrio con el GPS lo pone en el mapa y lo hace buscable por su nombre', async () => {
  const nombre = `Barrio GPS ${randomUUID().slice(0, 8)}`;
  const situada = await enTransaccion(pool, (c) => crearZonaEnGps(c, nombre, MALABO.lat, MALABO.lng));

  const zona = await pool.query(
    'SELECT centroide_lat, centroide_lng FROM zona WHERE id = $1',
    [situada.zonaId],
  );
  assert.equal(Number(zona.rows[0].centroide_lat), MALABO.lat);

  // Por partida doble, igual que el importador: como zona donde el taxista
  // declara que trabaja, y como referencia buscable, porque «llévame a Ela
  // Nguema» es como se pide un taxi de verdad.
  const referencia = await pool.query(
    'SELECT nombre, categoria, activa FROM referencia WHERE id = $1',
    [situada.referenciaId],
  );
  assert.equal(referencia.rows[0].nombre, nombre);
  assert.equal(referencia.rows[0].categoria, 'zona');
  assert.equal(referencia.rows[0].activa, true);
});

test('un barrio recién situado NUNCA queda aislado: el reparto tiene que poder llegar', async () => {
  const nombre = `Barrio Aislado ${randomUUID().slice(0, 8)}`;
  const situada = await enTransaccion(pool, (c) => crearZonaEnGps(c, nombre, MALABO.lat, MALABO.lng));

  // Sin vecinas, la tercera oleada del reparto no puede extenderse hasta aquí:
  // devolvería «no hay taxi» teniendo uno a cuatrocientos metros.
  assert.ok(
    await vecinasDe(situada.zonaId) > 0,
    'un barrio sin vecinas es invisible para la tercera oleada del reparto',
  );
  assert.ok(situada.vecinas > 0, 'y se dice cuántas parejas quedaron');
});

test('mover un barrio recoloca su referencia y vuelve a coser la adyacencia', async () => {
  const nombre = `Barrio Movido ${randomUUID().slice(0, 8)}`;
  const primera = await enTransaccion(pool, (c) => crearZonaEnGps(c, nombre, MALABO.lat, MALABO.lng));

  const destino = cerca(800);
  const segunda = await enTransaccion(pool, (c) => situarZona(c, primera.zonaId, destino.lat, destino.lng));

  // La misma referencia, recolocada: no se duplica el barrio en el buscador.
  assert.equal(segunda.referenciaId, primera.referenciaId, 'no se crea una segunda referencia');
  const ref = await pool.query('SELECT lat FROM referencia WHERE id = $1', [primera.referenciaId]);
  assert.ok(Math.abs(Number(ref.rows[0].lat) - destino.lat) < 1e-9, 'la referencia se movió con el barrio');
  assert.ok(await vecinasDe(primera.zonaId) > 0, 'sigue conectado tras moverse');
});

test('un barrio sin situar no es vecino de nadie: no se sabe dónde está', async () => {
  const huerfanas = await pool.query(
    `SELECT count(*)::int AS n FROM zona_adyacencia a
     JOIN zona z ON z.id = a.zona_id
     WHERE z.centroide_lat IS NULL`,
  );
  assert.equal(huerfanas.rows[0].n, 0);
});

test('se guarda con qué precisión se situó, para poder repetir los dudosos', async () => {
  const nombre = `Barrio Preciso ${randomUUID().slice(0, 8)}`;
  const situada = await enTransaccion(pool, (c) => crearZonaEnGps(c, nombre, MALABO.lat, MALABO.lng, 7.5));
  assert.equal(situada.precisionM, 7.5);

  const guardada = await pool.query('SELECT precision_gps_m FROM zona WHERE id = $1', [situada.zonaId]);
  assert.equal(Number(guardada.rows[0].precision_gps_m), 7.5);

  // Los que vinieron del importador no la tienen, y se dice que no se sabe en
  // vez de inventar un número que parecería igual de bueno.
  const importado = await pool.query(
    `SELECT precision_gps_m FROM zona WHERE nombre = 'Malabo Centro'`,
  );
  if ((importado.rowCount ?? 0) > 0) {
    assert.equal(importado.rows[0].precision_gps_m, null);
  }
});

// Los nombres de barrio se repiten de un distrito a otro —San Juan, Santa
// María, Puerto—, y el agente de campo teclea de memoria. Dar de alta uno
// que ya existe no puede acabar mudando el que ya estaba.
test('crear un barrio con un nombre ya situado se niega, y no mueve al que estaba', async () => {
  const nombre = `Barrio Repetido ${randomUUID().slice(0, 8)}`;
  const primera = await enTransaccion(pool, (c) => crearZonaEnGps(c, nombre, MALABO.lat, MALABO.lng));

  const lejos = cerca(3000);
  await assert.rejects(
    enTransaccion(pool, (c) => crearZonaEnGps(c, nombre, lejos.lat, lejos.lng)),
    /Ya existe/,
  );

  const quieto = await pool.query('SELECT centroide_lat FROM zona WHERE id = $1', [primera.zonaId]);
  assert.ok(
    Math.abs(Number(quieto.rows[0].centroide_lat) - MALABO.lat) < 1e-9,
    'el barrio que ya estaba no se movió a donde estaba el agente',
  );
});

test('pero si el barrio existe sin situar, estar delante de él es justo lo que faltaba', async () => {
  const nombre = `Barrio Pendiente ${randomUUID().slice(0, 8)}`;
  const previa = await pool.query('INSERT INTO zona (nombre) VALUES ($1) RETURNING id', [nombre]);
  const idPrevio = Number(previa.rows[0].id);

  const situada = await enTransaccion(pool, (c) => crearZonaEnGps(c, nombre, MALABO.lat, MALABO.lng));
  assert.equal(situada.zonaId, idPrevio, 'se sitúa el que ya estaba, no se duplica');
});

test('y situarlo no puede cambiarlo de distrito por el camino', async () => {
  const sufijo = randomUUID().slice(0, 8);
  const padre = await enTransaccion(pool, (c) => crearZonaEnGps(c, `Distrito ${sufijo}`, MALABO.lat, MALABO.lng));
  const nombre = `Barrio Ajeno ${sufijo}`;
  await pool.query('INSERT INTO zona (nombre) VALUES ($1)', [nombre]);

  await assert.rejects(
    enTransaccion(pool, (c) => crearZonaEnGps(c, nombre, MALABO.lat, MALABO.lng, null, padre.zonaId)),
    /Ya existe/,
  );
});
