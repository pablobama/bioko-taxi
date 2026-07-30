// Batería de la validación por proximidad GPS (migración 011). Requiere la
// base de datos de desarrollo arrancada, migrada y con la semilla cargada.
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { iniciarDespacho, reclamarSolicitud } from './despacho.js';
import { EmisorRegistro } from './eventos.js';
import { crearZona, guardarReferencia } from './gazetteer.js';
import { procesarProximidad, registrarPosicion } from './proximidad.js';
import { crearSolicitud, transicionarSolicitud } from './transiciones.js';


// Teléfono de pruebas que PUEDE existir: nueve dígitos locales, como los de
// Malabo. Los fixtures fabricaban antes números de dieciséis dígitos, que la
// validación vieja dejaba pasar porque solo miraba la longitud del texto.
let contadorTelefono = 0;
function telefonoUnico(): string {
  contadorTelefono += 1;
  const aleatorio = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `+240222${aleatorio}${String(contadorTelefono % 1000).padStart(3, '0')}`;
}

let pool: pg.Pool;

before(async () => {
  pool = crearPool();
});

after(async () => {
  await pool.end();
});

interface ViajeEnCamino {
  solicitudId: number;
  viajeId: number;
  conductorId: number;
}

// Un viaje real llevado hasta EN_CAMINO por el dominio, en una zona propia.
async function montarViajeEnCamino(): Promise<ViajeEnCamino> {
  const emisor = new EmisorRegistro();
  return enTransaccion(pool, async (c) => {
    const zonaId = (await crearZona(c, `Zona GPS ${randomUUID()}`, 3.75, 8.78)).zonaId;
    const origenId = (await guardarReferencia(c, {
      zonaId, nombre: 'Origen GPS', lat: 3.75, lng: 8.78,
    })).referenciaId;
    const destinoId = (await guardarReferencia(c, {
      zonaId, nombre: 'Destino GPS', lat: 3.76, lng: 8.79,
    })).referenciaId;
    const conductor = await c.query(
      `INSERT INTO conductor (telefono, nombre, estado_verificacion, suscrito_hasta)
       VALUES ($1, 'Conductora GPS', 'verificado', now() + interval '1 day') RETURNING id`,
      [telefonoUnico()],
    );
    const conductorId: number = conductor.rows[0].id;
    await c.query(
      'INSERT INTO vehiculo (conductor_id, matricula) VALUES ($1, $2)',
      [conductorId, `GE-${Date.now()}${Math.floor(Math.random() * 100000)}-G`],
    );
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
      telefonoCliente: '+240222999991',
      referenciaOrigenId: origenId,
      referenciaDestinoId: destinoId,
      actor: 'cliente',
      claveIdempotencia: `gps-${randomUUID()}`,
    });
    return { solicitudId: creada.solicitudId, conductorId };
  }).then(async ({ solicitudId, conductorId }) => {
    await iniciarDespacho(pool, emisor, solicitudId);
    const reclamacion = await reclamarSolicitud(pool, emisor, solicitudId, conductorId);
    assert.equal(reclamacion.gano, true);
    await enTransaccion(pool, (c) => transicionarSolicitud(c, solicitudId, 'EN_CAMINO', 'conductor'));
    return { solicitudId, viajeId: reclamacion.viajeId!, conductorId };
  });
}

async function ponerPosicion(
  viajeId: number,
  actor: 'cliente' | 'conductor',
  lat: number,
  lng: number,
  ahora: Date,
): Promise<void> {
  await enTransaccion(pool, (c) => registrarPosicion(c, viajeId, actor, lat, lng, ahora));
}

async function estadoDe(solicitudId: number): Promise<string> {
  const res = await pool.query('SELECT estado FROM solicitud WHERE id = $1', [solicitudId]);
  return res.rows[0].estado;
}

test('recogida automática por proximidad y cierre automático por separación', async () => {
  const viaje = await montarViajeEnCamino();
  const emisor = new EmisorRegistro();
  const t0 = new Date();

  // Taxi y cliente a ~40 m: recogida automática.
  await ponerPosicion(viaje.viajeId, 'conductor', 3.7500, 8.7800, t0);
  await ponerPosicion(viaje.viajeId, 'cliente', 3.7503, 8.7802, t0);
  await procesarProximidad(pool, emisor, t0);
  assert.equal(await estadoDe(viaje.solicitudId), 'RECOGIDO');

  const validado = await pool.query(
    'SELECT validado_en, distancia_validacion_m FROM viaje WHERE id = $1',
    [viaje.viajeId],
  );
  assert.notEqual(validado.rows[0].validado_en, null);
  assert.ok(Number(validado.rows[0].distancia_validacion_m) <= 75);

  // Viajan juntos: nada cambia.
  const t1 = new Date(t0.getTime() + 60_000);
  await ponerPosicion(viaje.viajeId, 'conductor', 3.7550, 8.7850, t1);
  await ponerPosicion(viaje.viajeId, 'cliente', 3.7551, 8.7851, t1);
  await procesarProximidad(pool, emisor, t1);
  assert.equal(await estadoDe(viaje.solicitudId), 'RECOGIDO');

  // Se separan más de 250 m: servicio realizado, cierre automático.
  const t2 = new Date(t0.getTime() + 120_000);
  await ponerPosicion(viaje.viajeId, 'conductor', 3.7600, 8.7900, t2);
  await ponerPosicion(viaje.viajeId, 'cliente', 3.7630, 8.7900, t2);
  await procesarProximidad(pool, emisor, t2);
  assert.equal(await estadoDe(viaje.solicitudId), 'COMPLETADO');

  const cerrado = await pool.query('SELECT completado_en FROM viaje WHERE id = $1', [viaje.viajeId]);
  assert.notEqual(cerrado.rows[0].completado_en, null);
  const presencia = await pool.query(
    'SELECT estado FROM presencia WHERE conductor_id = $1',
    [viaje.conductorId],
  );
  assert.equal(presencia.rows[0].estado, 'DISPONIBLE');
  // La app del conductor recibe el aviso del cierre automático.
  assert.ok(emisor.deTipo('D3_viaje_cerrado_comision')
    .some((e) => e.conductorId === viaje.conductorId && e.datos.motivo === 'separacion_gps'));
});

test('un viaje problemático no deja sin detección a los demás', async () => {
  const roto = await montarViajeEnCamino();
  const sano = await montarViajeEnCamino();
  const emisor = new EmisorRegistro();
  const t0 = new Date();

  // Se rompe el viaje del primero por debajo del dominio: su presencia queda
  // en un estado desde el que no hay transición válida a DISPONIBLE.
  await pool.query(
    `UPDATE presencia SET estado = 'OFERTADO' WHERE conductor_id = $1`,
    [roto.conductorId],
  );
  await ponerPosicion(roto.viajeId, 'conductor', 3.7500, 8.7800, t0);
  await ponerPosicion(roto.viajeId, 'cliente', 3.7501, 8.7801, t0);
  await enTransaccion(pool, (c) => transicionarSolicitud(c, roto.solicitudId, 'RECOGIDO', 'conductor'));
  await ponerPosicion(roto.viajeId, 'conductor', 3.7600, 8.7900, t0);
  await ponerPosicion(roto.viajeId, 'cliente', 3.7640, 8.7900, t0);

  // El sano solo necesita que se le detecte la recogida.
  await ponerPosicion(sano.viajeId, 'conductor', 3.7500, 8.7800, t0);
  await ponerPosicion(sano.viajeId, 'cliente', 3.7502, 8.7801, t0);

  await procesarProximidad(pool, emisor, t0);
  assert.equal(await estadoDe(sano.solicitudId), 'RECOGIDO', 'el viaje sano debe procesarse igual');
});

test('sin posición del cliente no se decide nada: la confirmación manual sigue siendo el respaldo', async () => {
  const viaje = await montarViajeEnCamino();
  const emisor = new EmisorRegistro();
  const t0 = new Date();

  await ponerPosicion(viaje.viajeId, 'conductor', 3.7500, 8.7800, t0);
  await procesarProximidad(pool, emisor, t0);
  assert.equal(await estadoDe(viaje.solicitudId), 'EN_CAMINO');
});

test('una posición rancia (más vieja que gps_frescura_seg) no cuenta', async () => {
  const viaje = await montarViajeEnCamino();
  const emisor = new EmisorRegistro();
  const t0 = new Date();

  // El cliente mandó su posición hace 2 minutos y cerró la pantalla.
  await ponerPosicion(viaje.viajeId, 'cliente', 3.7500, 8.7800, new Date(t0.getTime() - 120_000));
  await ponerPosicion(viaje.viajeId, 'conductor', 3.7500, 8.7800, t0);
  await procesarProximidad(pool, emisor, t0);
  assert.equal(await estadoDe(viaje.solicitudId), 'EN_CAMINO');
});
