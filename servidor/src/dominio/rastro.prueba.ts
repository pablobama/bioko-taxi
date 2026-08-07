// Pruebas del recorrido del taxi durante el turno (migración 042).
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { purgarRastro, recorridoDe, registrarRastro } from './rastro.js';

let pool: pg.Pool;

before(() => {
  pool = crearPool();
});

after(async () => {
  await pool.end();
});

// Ocho dígitos aleatorios, no seis: la base de desarrollo guarda los teléfonos
// de todas las ejecuciones anteriores (P12-03), y con un millón de números
// posibles las colisiones contra ejecuciones viejas dejan de ser raras y
// revientan el UNIQUE del teléfono a mitad de la batería.
let siguienteTelefono = Math.floor(Math.random() * 100_000_000);
function telefonoUnico(): string {
  siguienteTelefono = (siguienteTelefono + 1) % 100_000_000;
  return `+2406${String(siguienteTelefono).padStart(8, '0')}`;
}

// Un conductor con presencia en el estado que se pida. La zona da igual aquí:
// el rastro cuelga del conductor, no del barrio.
async function crearConductor(estado = 'DISPONIBLE'): Promise<number> {
  return enTransaccion(pool, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO conductor (telefono, nombre) VALUES ($1, 'Taxi RAS') RETURNING id`,
      [telefonoUnico()],
    );
    const conductorId: number = rows[0].id;
    await c.query(
      `INSERT INTO presencia (conductor_id, estado, ultimo_heartbeat)
       VALUES ($1, $2, now())`,
      [conductorId, estado],
    );
    return conductorId;
  });
}

const BASE = new Date('2026-08-05T08:00:00Z');
const enSegundo = (s: number) => new Date(BASE.getTime() + s * 1000);
// Un grado de latitud son ~111 km: esto son metros hacia el norte.
const aMetros = (m: number) => ({ lat: 3.75 + m / 111_320, lng: 8.78 });

const guardar = (id: number, m: number, seg: number) =>
  enTransaccion(pool, (c) => {
    const p = aMetros(m);
    return registrarRastro(c, id, p.lat, p.lng, enSegundo(seg));
  });

test('el primer punto del turno siempre se guarda: es por dónde empezó', async () => {
  const id = await crearConductor();
  assert.equal(await guardar(id, 0, 0), true);
});

test('dos latidos seguidos no son dos puntos: entre ellos solo hay ruido de GPS', async () => {
  const id = await crearConductor();
  await guardar(id, 0, 0);
  // El latido va cada 20 s y el intervalo mínimo es 45: aunque el coche haya
  // cruzado media ciudad, este punto no entra. Es lo que corta de 180 puntos
  // por hora a 80, y sin ello un mes de cien taxis no cabe en la base.
  assert.equal(await guardar(id, 500, 20), false, 'demasiado pronto, aunque se haya movido');
});

test('pasado el intervalo, moverse guarda punto y no moverse no', async () => {
  const quieto = await crearConductor();
  await guardar(quieto, 0, 0);
  // 10 m es menos que los 40 del parámetro: el coche está parado y lo que se
  // ve entre lectura y lectura es el temblor del GPS.
  assert.equal(await guardar(quieto, 10, 60), false);

  const andando = await crearConductor();
  await guardar(andando, 0, 0);
  assert.equal(await guardar(andando, 300, 60), true);
});

test('el taxi parado deja un punto cada tanto: «estuvo ahí» no es «no se sabe»', async () => {
  const id = await crearConductor();
  await guardar(id, 0, 0);
  assert.equal(await guardar(id, 5, 120), false, 'a los dos minutos todavía no');
  // El anclaje son 300 s. Sin él, un taxi que espera dos horas en la parada
  // del mercado sale en el mapa como un punto suelto y un agujero enorme.
  assert.equal(await guardar(id, 5, 400), true, 'a los seis minutos sí, aunque no se haya movido');
});

test('quien no está en servicio no deja rastro, aunque su móvil lo mande', async () => {
  const id = await crearConductor('DESCONECTADO');
  assert.equal(await guardar(id, 0, 0), false);
  const r = await recorridoDe(pool, id, enSegundo(-1000), enSegundo(1000));
  assert.equal(r.puntos, 0, 'ni un punto: su vida fuera del turno no se registra');
});

test('un hueco largo parte el recorrido en dos tramos, sin unirlos por el aire', async () => {
  const id = await crearConductor();
  await guardar(id, 0, 0);
  await guardar(id, 300, 60);
  // Media hora después reaparece a tres kilómetros: salió de servicio, o se
  // quedó sin cobertura. Unir esos dos puntos dibujaría una línea recta por
  // encima de la ciudad que nadie recorrió.
  await guardar(id, 3000, 2400);
  await guardar(id, 3300, 2460);

  const r = await recorridoDe(pool, id, enSegundo(-100), enSegundo(3000));
  assert.equal(r.puntos, 4);
  assert.equal(r.tramos.length, 2, 'dos tramos, no uno atravesando el hueco');
  assert.equal(r.tramos[0].length, 2);
  assert.equal(r.tramos[1].length, 2);
});

test('los metros son los que anduvo de verdad, no los del salto entre tramos', async () => {
  const id = await crearConductor();
  await guardar(id, 0, 0);
  await guardar(id, 300, 60);
  await guardar(id, 3000, 2400);
  await guardar(id, 3300, 2460);

  const r = await recorridoDe(pool, id, enSegundo(-100), enSegundo(3000));
  // 300 m de un tramo y 300 del otro. Los 2.700 m del salto no cuentan:
  // nadie los recorrió, y sumarlos inflaría el kilometraje del taxista.
  assert.ok(Math.abs(r.metros - 600) < 15, `esperaba ~600 m y salieron ${r.metros}`);
});

test('un punto suelto no es un recorrido: no hay línea que dibujar', async () => {
  const id = await crearConductor();
  await guardar(id, 0, 0);
  const r = await recorridoDe(pool, id, enSegundo(-100), enSegundo(100));
  assert.equal(r.puntos, 1, 'el punto está guardado');
  assert.equal(r.tramos.length, 0, 'pero no se dibuja');
});

test('la ventana del periodo no se lleva lo de al lado', async () => {
  const id = await crearConductor();
  await guardar(id, 0, 0);
  await guardar(id, 300, 60);
  const fuera = await recorridoDe(pool, id, enSegundo(600), enSegundo(1200));
  assert.equal(fuera.puntos, 0);
});

test('un recorrido largo se aligera para mandarlo, pero el kilometraje no miente', async () => {
  const id = await crearConductor();
  for (let i = 0; i < 60; i += 1) {
    await guardar(id, i * 300, i * 60);
  }
  const r = await recorridoDe(pool, id, enSegundo(-100), enSegundo(10_000), 10);
  assert.equal(r.puntos, 60, 'se dice cuántos hay de verdad');
  const dibujados = r.tramos.reduce((n, t) => n + t.length, 0);
  assert.ok(dibujados <= 12, `se mandan ${dibujados}, que es un puñado y no sesenta`);
  // 59 saltos de 300 m. Medido sobre los puntos completos, no sobre los
  // dibujados: si se midiera después de aligerar, un mes saldría más corto
  // que una semana del mismo taxi solo por dibujarse con menos puntos.
  assert.ok(Math.abs(r.metros - 17_700) < 200, `esperaba ~17.700 m y salieron ${r.metros}`);
});

test('la purga se lleva lo viejo y respeta lo de dentro del plazo', async () => {
  const id = await crearConductor();
  const ahora = new Date();
  const hace = (dias: number) => new Date(ahora.getTime() - dias * 86_400_000);
  await pool.query(
    `INSERT INTO rastro (conductor_id, lat, lng, creado_en)
     VALUES ($1, 3.75, 8.78, $2), ($1, 3.75, 8.78, $3)`,
    [id, hace(200), hace(2)],
  );

  await purgarRastro(pool, ahora);

  const quedan = await pool.query(
    'SELECT count(*)::int AS n FROM rastro WHERE conductor_id = $1',
    [id],
  );
  assert.equal(quedan.rows[0].n, 1, 'se va el de hace 200 días, se queda el de anteayer');
});

test('el rastro de un taxi no es el de otro', async () => {
  const uno = await crearConductor();
  const otro = await crearConductor();
  await guardar(uno, 0, 0);
  await guardar(uno, 300, 60);

  const r = await recorridoDe(pool, otro, enSegundo(-100), enSegundo(1000));
  assert.equal(r.puntos, 0, `el conductor ${otro} no hereda el recorrido de ${uno} (${randomUUID().slice(0, 4)})`);
});
