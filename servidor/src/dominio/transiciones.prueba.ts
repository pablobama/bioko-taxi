// Batería de aceptación del paso 2. Requiere la base de datos de desarrollo
// arrancada (npm run bd:dev), migrada y con la semilla cargada.
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { ErrorEntidadInexistente, ErrorTransicionInvalida } from './errores.js';
import {
  crearSolicitud, transicionarConductor, transicionarSolicitud, type Actor,
} from './transiciones.js';

let pool: pg.Pool;
let dispositivoClienteId: number;
let referenciaOrigenId: number;
let referenciaDestinoId: number;

before(async () => {
  pool = crearPool();
  const referencias = await pool.query('SELECT id FROM referencia ORDER BY id LIMIT 2');
  assert.equal(referencias.rowCount, 2, 'Faltan referencias: carga la semilla (npm run bd:semilla)');
  referenciaOrigenId = referencias.rows[0].id;
  referenciaDestinoId = referencias.rows[1].id;
  const dispositivo = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES (gen_random_uuid(), 'cliente') RETURNING id`,
  );
  dispositivoClienteId = dispositivo.rows[0].id;
});

after(async () => {
  await pool.end();
});

async function nuevaSolicitud(): Promise<number> {
  const creada = await enTransaccion(pool, (cliente) => crearSolicitud(cliente, {
    dispositivoClienteId,
    telefonoCliente: '+240222999999',
    referenciaOrigenId,
    referenciaDestinoId,
    actor: 'cliente',
    claveIdempotencia: `prueba-${randomUUID()}`,
  }));
  return creada.solicitudId;
}

async function avanzar(solicitudId: number, pasos: Array<[string, Actor]>): Promise<void> {
  for (const [destino, actor] of pasos) {
    await enTransaccion(pool, (cliente) =>
      transicionarSolicitud(cliente, solicitudId, destino, actor));
  }
}

async function estadoDe(solicitudId: number): Promise<string> {
  const res = await pool.query('SELECT estado FROM solicitud WHERE id = $1', [solicitudId]);
  return res.rows[0].estado;
}

test('camino feliz: SOLICITADO → ... → COMPLETADO con log completo', async () => {
  const id = await nuevaSolicitud();
  await avanzar(id, [
    ['EMITIDO', 'sistema'],
    ['ACEPTADO', 'conductor'],
    ['EN_CAMINO', 'conductor'],
    ['RECOGIDO', 'conductor'],
    ['COMPLETADO', 'conductor'],
  ]);
  assert.equal(await estadoDe(id), 'COMPLETADO');

  const log = await pool.query(
    'SELECT estado_anterior, estado_nuevo, actor FROM transicion WHERE solicitud_id = $1 ORDER BY id',
    [id],
  );
  assert.deepEqual(
    log.rows.map((f) => [f.estado_anterior, f.estado_nuevo]),
    [
      [null, 'SOLICITADO'],
      ['SOLICITADO', 'EMITIDO'],
      ['EMITIDO', 'ACEPTADO'],
      ['ACEPTADO', 'EN_CAMINO'],
      ['EN_CAMINO', 'RECOGIDO'],
      ['RECOGIDO', 'COMPLETADO'],
    ],
  );
});

test('creación idempotente: la misma clave no crea segunda solicitud ni segunda transición', async () => {
  const clave = `prueba-idempotencia-${randomUUID()}`;
  const datos = {
    dispositivoClienteId,
    telefonoCliente: '+240222999998',
    referenciaOrigenId,
    referenciaDestinoId,
    actor: 'cliente' as Actor,
    claveIdempotencia: clave,
  };
  const primera = await enTransaccion(pool, (c) => crearSolicitud(c, datos));
  const segunda = await enTransaccion(pool, (c) => crearSolicitud(c, datos));
  assert.equal(primera.yaExistia, false);
  assert.equal(segunda.yaExistia, true);
  assert.equal(segunda.solicitudId, primera.solicitudId);

  const log = await pool.query(
    'SELECT count(*)::int AS n FROM transicion WHERE solicitud_id = $1',
    [primera.solicitudId],
  );
  assert.equal(log.rows[0].n, 1);
});

test('el operador puede crear solicitudes (canal de voz, 3.6)', async () => {
  const creada = await enTransaccion(pool, (cliente) => crearSolicitud(cliente, {
    dispositivoClienteId,
    telefonoCliente: '+240222999997',
    referenciaOrigenId,
    referenciaDestinoId,
    actor: 'operador',
    claveIdempotencia: `prueba-voz-${randomUUID()}`,
    origenEvento: 'llamada_voz',
  }));
  assert.equal(await estadoDe(creada.solicitudId), 'SOLICITADO');
});

// Cada terminal de fallo de 5.2, con el camino que lleva hasta él.
const TERMINALES: Array<{
  nombre: string;
  camino: Array<[string, Actor]>;
  terminal: [string, Actor];
}> = [
  {
    nombre: 'SIN_OFERTA directo por zona vacía (R1)',
    camino: [],
    terminal: ['SIN_OFERTA', 'sistema'],
  },
  {
    nombre: 'SIN_OFERTA tras agotar oleadas',
    camino: [['EMITIDO', 'sistema']],
    terminal: ['SIN_OFERTA', 'sistema'],
  },
  {
    nombre: 'CANCELADO_CLIENTE durante la emisión',
    camino: [['EMITIDO', 'sistema']],
    terminal: ['CANCELADO_CLIENTE', 'cliente'],
  },
  {
    nombre: 'CANCELADO_CLIENTE en gracia de 60 s tras aceptación',
    camino: [['EMITIDO', 'sistema'], ['ACEPTADO', 'conductor']],
    terminal: ['CANCELADO_CLIENTE', 'cliente'],
  },
  {
    nombre: 'CANCELADO_CONDUCTOR',
    camino: [['EMITIDO', 'sistema'], ['ACEPTADO', 'conductor']],
    terminal: ['CANCELADO_CONDUCTOR', 'conductor'],
  },
  {
    nombre: 'NO_PRESENTADO declarado por el sistema',
    camino: [['EMITIDO', 'sistema'], ['ACEPTADO', 'conductor'], ['EN_CAMINO', 'conductor']],
    terminal: ['NO_PRESENTADO', 'sistema'],
  },
  {
    nombre: 'NO_PRESENTADO declarado por el conductor',
    camino: [['EMITIDO', 'sistema'], ['ACEPTADO', 'conductor'], ['EN_CAMINO', 'conductor']],
    terminal: ['NO_PRESENTADO', 'conductor'],
  },
  {
    nombre: 'CLIENTE_AUSENTE con reloj agotado',
    camino: [['EMITIDO', 'sistema'], ['ACEPTADO', 'conductor'], ['EN_CAMINO', 'conductor']],
    terminal: ['CLIENTE_AUSENTE', 'conductor'],
  },
  {
    nombre: 'INCIDENCIA declarada tras la recogida',
    camino: [
      ['EMITIDO', 'sistema'], ['ACEPTADO', 'conductor'],
      ['EN_CAMINO', 'conductor'], ['RECOGIDO', 'conductor'],
    ],
    terminal: ['INCIDENCIA', 'cliente'],
  },
];

for (const caso of TERMINALES) {
  test(`terminal de fallo: ${caso.nombre}`, async () => {
    const id = await nuevaSolicitud();
    await avanzar(id, caso.camino);
    await avanzar(id, [caso.terminal]);
    assert.equal(await estadoDe(id), caso.terminal[0]);

    // De un terminal no se sale: cualquier intento posterior se rechaza.
    await assert.rejects(
      avanzar(id, [['EMITIDO', 'sistema']]),
      ErrorTransicionInvalida,
    );
  });
}

test('reasignación automática (R3): ACEPTADO → EMITIDO y el viaje puede completarse después', async () => {
  const id = await nuevaSolicitud();
  await avanzar(id, [
    ['EMITIDO', 'sistema'],
    ['ACEPTADO', 'conductor'],
    ['EMITIDO', 'sistema'], // el conductor no confirmó salida en 90 s
    ['ACEPTADO', 'conductor'],
    ['EN_CAMINO', 'conductor'],
    ['RECOGIDO', 'conductor'],
    ['COMPLETADO', 'conductor'],
  ]);
  assert.equal(await estadoDe(id), 'COMPLETADO');
});

test('rechazo: saltarse pasos (SOLICITADO → RECOGIDO)', async () => {
  const id = await nuevaSolicitud();
  await assert.rejects(
    avanzar(id, [['RECOGIDO', 'conductor']]),
    (error: unknown) => {
      assert.ok(error instanceof ErrorTransicionInvalida);
      assert.match(error.message, /SOLICITADO → RECOGIDO/);
      assert.match(error.message, /Permitidas desde SOLICITADO/);
      return true;
    },
  );
  assert.equal(await estadoDe(id), 'SOLICITADO');
});

test('rechazo: actor equivocado (el cliente no puede aceptar por el conductor)', async () => {
  const id = await nuevaSolicitud();
  await avanzar(id, [['EMITIDO', 'sistema']]);
  await assert.rejects(
    avanzar(id, [['ACEPTADO', 'cliente']]),
    ErrorTransicionInvalida,
  );
  assert.equal(await estadoDe(id), 'EMITIDO');
});

test('rechazo: una transición inválida no deja rastro en el log', async () => {
  const id = await nuevaSolicitud();
  await assert.rejects(avanzar(id, [['COMPLETADO', 'conductor']]), ErrorTransicionInvalida);
  const log = await pool.query(
    'SELECT count(*)::int AS n FROM transicion WHERE solicitud_id = $1',
    [id],
  );
  assert.equal(log.rows[0].n, 1); // solo la creación
});

test('rechazo: solicitud inexistente', async () => {
  await assert.rejects(
    enTransaccion(pool, (c) => transicionarSolicitud(c, 999_999_999, 'EMITIDO', 'sistema')),
    ErrorEntidadInexistente,
  );
});

test('máquina del conductor: ciclo completo y rechazo de atajos', async () => {
  // Conductor propio de la prueba para no interferir con la semilla.
  const conductor = await pool.query(
    `INSERT INTO conductor (telefono, nombre, estado_verificacion)
     VALUES ($1, 'Conductor De Prueba', 'verificado') RETURNING id`,
    [`+2402228${Date.now()}${Math.floor(Math.random() * 1000)}`],
  );
  const conductorId: number = conductor.rows[0].id;
  await pool.query('INSERT INTO presencia (conductor_id, estado) VALUES ($1, $2)', [conductorId, 'DESCONECTADO']);

  const pasos: Array<[string, Actor]> = [
    ['DISPONIBLE', 'conductor'],
    ['OFERTADO', 'sistema'],
    ['OCUPADO', 'conductor'],
    ['DISPONIBLE', 'conductor'],
    ['DESCONECTADO', 'sistema'],
  ];
  for (const [destino, actor] of pasos) {
    await enTransaccion(pool, (c) => transicionarConductor(c, conductorId, destino, actor));
  }

  const presencia = await pool.query('SELECT estado FROM presencia WHERE conductor_id = $1', [conductorId]);
  assert.equal(presencia.rows[0].estado, 'DESCONECTADO');

  // DISPONIBLE → OCUPADO sin pasar por OFERTADO no existe en la tabla.
  await enTransaccion(pool, (c) => transicionarConductor(c, conductorId, 'DISPONIBLE', 'conductor'));
  await assert.rejects(
    enTransaccion(pool, (c) => transicionarConductor(c, conductorId, 'OCUPADO', 'conductor')),
    ErrorTransicionInvalida,
  );

  const log = await pool.query(
    'SELECT count(*)::int AS n FROM transicion WHERE conductor_id = $1 AND ambito = $2',
    [conductorId, 'conductor'],
  );
  assert.equal(log.rows[0].n, 6);
});
