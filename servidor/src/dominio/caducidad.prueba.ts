// Viajes que nadie cerró (migración 052).
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { caducarViajesColgados } from './caducidad.js';
import { iniciarDespacho, reclamarSolicitud } from './despacho.js';
import { EmisorRegistro } from './eventos.js';
import { crearZona, guardarReferencia } from './gazetteer.js';
import { crearSolicitud, transicionarSolicitud } from './transiciones.js';

let pool: pg.Pool;

before(() => { pool = crearPool(); });
after(async () => { await pool.end(); });

let siguienteTelefono = Math.floor(Math.random() * 100_000_000);
function telefonoUnico(): string {
  siguienteTelefono = (siguienteTelefono + 1) % 100_000_000;
  return `+2406${String(siguienteTelefono).padStart(8, '0')}`;
}

interface Montado { solicitudId: number; viajeId: number; conductorId: number }

// Un viaje real llevado por el dominio hasta el estado que se pida.
async function montar(estadoFinal: 'EN_CAMINO' | 'RECOGIDO'): Promise<Montado> {
  const emisor = new EmisorRegistro();
  const { solicitudId, conductorId } = await enTransaccion(pool, async (c) => {
    const zonaId = (await crearZona(c, `Zona CAD ${randomUUID()}`, 3.75, 8.78)).zonaId;
    const origenId = (await guardarReferencia(c, {
      zonaId, nombre: 'Origen CAD', lat: 3.75, lng: 8.78,
    })).referenciaId;
    const destinoId = (await guardarReferencia(c, {
      zonaId, nombre: 'Destino CAD', lat: 3.76, lng: 8.79,
    })).referenciaId;
    const conductor = await c.query(
      `INSERT INTO conductor (telefono, nombre, estado_verificacion, suscrito_hasta)
       VALUES ($1, 'Taxi CAD', 'verificado', now() + interval '1 day') RETURNING id`,
      [telefonoUnico()],
    );
    const conductorId: number = conductor.rows[0].id;
    await c.query('INSERT INTO vehiculo (conductor_id, matricula) VALUES ($1, $2)',
      [conductorId, `GE-CAD${Date.now()}${Math.floor(Math.random() * 10000)}-G`]);
    await c.query('INSERT INTO monedero (conductor_id) VALUES ($1)', [conductorId]);
    await c.query(
      `INSERT INTO presencia (conductor_id, zona_id, estado, ultimo_heartbeat)
       VALUES ($1, $2, 'DISPONIBLE', now())`,
      [conductorId, zonaId],
    );
    const dispositivo = await c.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES (gen_random_uuid(), 'cliente') RETURNING id`,
    );
    const creada = await crearSolicitud(c, {
      dispositivoClienteId: dispositivo.rows[0].id,
      telefonoCliente: '+240222999992',
      referenciaOrigenId: origenId,
      referenciaDestinoId: destinoId,
      actor: 'cliente',
      claveIdempotencia: `cad-${randomUUID()}`,
    });
    return { solicitudId: creada.solicitudId, conductorId };
  });
  await iniciarDespacho(pool, emisor, solicitudId);
  const reclamacion = await reclamarSolicitud(pool, emisor, solicitudId, conductorId);
  assert.equal(reclamacion.gano, true);
  await enTransaccion(pool, (c) => transicionarSolicitud(c, solicitudId, 'EN_CAMINO', 'conductor'));
  if (estadoFinal === 'RECOGIDO') {
    await enTransaccion(pool, (c) => transicionarSolicitud(c, solicitudId, 'RECOGIDO', 'conductor'));
  }
  return { solicitudId, viajeId: reclamacion.viajeId!, conductorId };
}

const estadoDe = async (id: number) =>
  (await pool.query('SELECT estado FROM solicitud WHERE id = $1', [id])).rows[0].estado;

const horas = (n: number) => new Date(Date.now() + n * 3600_000);

test('un viaje recogido que nadie cierra acaba cerrándose solo', async () => {
  const viaje = await montar('RECOGIDO');
  const emisor = new EmisorRegistro();

  // A las tres horas todavía no: el tope son cuatro y hay que dar margen.
  await caducarViajesColgados(pool, emisor, horas(3));
  assert.equal(await estadoDe(viaje.solicitudId), 'RECOGIDO');

  // `>= 1` y no `=== 1`: la barrida mira TODAS las solicitudes, y la base de
  // desarrollo arrastra viajes sueltos de otras pruebas. Lo que se comprueba
  // aquí es este viaje, no cuántos había colgados en la base.
  const cuenta = await caducarViajesColgados(pool, emisor, horas(5));
  assert.ok(cuenta.completados >= 1);
  assert.equal(await estadoDe(viaje.solicitudId), 'COMPLETADO');

  // El taxista recupera su plaza: sin esto se queda ocupado para siempre y el
  // reparto deja de contar con él.
  const presencia = await pool.query(
    'SELECT estado FROM presencia WHERE conductor_id = $1', [viaje.conductorId],
  );
  assert.equal(presencia.rows[0].estado, 'DISPONIBLE');
  // Y cobra su comisión: el viaje ocurrió, lo que faltó fue pulsar el botón.
  assert.ok(emisor.deTipo('D3_viaje_cerrado_comision')
    .some((e) => e.datos.motivo === 'viaje_caducado'));
});

test('el viaje caducado consta terminado en la última señal, no cuando se detecta', async () => {
  const viaje = await montar('RECOGIDO');
  const emisor = new EmisorRegistro();
  const ultima = new Date(Date.now() - 1000);
  await pool.query(
    `INSERT INTO posicion (viaje_id, actor, lat, lng, creado_en)
     VALUES ($1, 'conductor', 3.75, 8.78, $2)`,
    [viaje.viajeId, ultima],
  );

  await caducarViajesColgados(pool, emisor, horas(5));
  const fila = await pool.query('SELECT completado_en FROM viaje WHERE id = $1', [viaje.viajeId]);
  const completado = new Date(fila.rows[0].completado_en).getTime();
  assert.ok(
    Math.abs(completado - ultima.getTime()) < 2000,
    'se cierra en la última posición conocida, no cinco horas después',
  );
});

test('un taxi de camino que nunca recoge no cobra comisión', async () => {
  const viaje = await montar('EN_CAMINO');
  const emisor = new EmisorRegistro();

  await caducarViajesColgados(pool, emisor, horas(1));
  assert.equal(await estadoDe(viaje.solicitudId), 'EN_CAMINO', 'a la hora todavía no');

  const cuenta = await caducarViajesColgados(pool, emisor, horas(3));
  assert.ok(cuenta.noPresentados >= 1);
  assert.equal(await estadoDe(viaje.solicitudId), 'NO_PRESENTADO');
  assert.equal(
    emisor.deTipo('D3_viaje_cerrado_comision').length, 0,
    'nadie subió al coche: no hay viaje que cobrar',
  );
});

test('un viaje recién empezado no se toca', async () => {
  const viaje = await montar('RECOGIDO');
  const emisor = new EmisorRegistro();
  await caducarViajesColgados(pool, emisor, new Date());
  assert.equal(await estadoDe(viaje.solicitudId), 'RECOGIDO');
});

test('caducar dos veces no cierra dos veces', async () => {
  const viaje = await montar('RECOGIDO');
  const emisor = new EmisorRegistro();
  await caducarViajesColgados(pool, emisor, horas(5));
  const emisorSegundo = new EmisorRegistro();
  await caducarViajesColgados(pool, emisorSegundo, horas(6));
  assert.equal(await estadoDe(viaje.solicitudId), 'COMPLETADO');
  assert.equal(
    emisorSegundo.deTipo('D3_viaje_cerrado_comision')
      .filter((e) => e.solicitudId === viaje.solicitudId).length,
    0,
    'la segunda pasada no vuelve a cobrar comisión por el mismo viaje',
  );
});
