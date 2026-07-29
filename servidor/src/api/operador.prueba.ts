// Pruebas del panel de operador: acceso por uuid, fichas, incidencias y
// desbloqueo. Requiere la base de desarrollo arrancada y migrada.
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { EmisorRegistro } from '../dominio/eventos.js';
import { crearZona, guardarReferencia } from '../dominio/gazetteer.js';
import { procesarClienteAusente } from '../dominio/monedero.js';
import { ConexionesSse } from '../eventos/adaptador-sse.js';
import { crearServidor } from './servidor.js';

const UUID_OPERADOR = randomUUID();

let pool: pg.Pool;
let app: FastifyInstance;

before(async () => {
  // La lista de operadores llega por entorno; para las pruebas se inyecta
  // antes de crear el servidor, igual que hará Render en producción.
  process.env.UUIDS_OPERADOR = `${UUID_OPERADOR}, otro-texto-que-se-ignora`;
  pool = crearPool();
  app = crearServidor(pool, new EmisorRegistro(), new ConexionesSse());
});

after(async () => {
  delete process.env.UUIDS_OPERADOR;
  await app.close();
  await pool.end();
});

function cabeceras(uuid: string): Record<string, string> {
  return { 'x-dispositivo': uuid, 'content-type': 'application/json' };
}

// Un viaje terminado en «cliente ausente con sesión activa», que es lo que
// alimenta la cola de incidencias, con su pasajero y su conductor.
async function crearIncidencia(): Promise<{
  incidenciaId: number; dispositivoId: number; viajeId: number;
}> {
  return enTransaccion(pool, async (c) => {
    const { zonaId } = await crearZona(c, `Zona OP ${randomUUID()}`, 3.75, 8.78);
    const { referenciaId: origenId } = await guardarReferencia(c, {
      zonaId, nombre: 'Origen OP', lat: 3.75, lng: 8.78,
    });
    const { referenciaId: destinoId } = await guardarReferencia(c, {
      zonaId, nombre: 'Destino OP', lat: 3.751, lng: 8.781,
    });
    const dispositivo = await c.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES ($1, 'cliente') RETURNING id`,
      [randomUUID()],
    );
    const dispositivoId: number = dispositivo.rows[0].id;
    const conductor = await c.query(
      `INSERT INTO conductor (telefono, nombre, estado_verificacion)
       VALUES ($1, 'Conductor OP', 'verificado') RETURNING id`,
      [`+2402224${Date.now()}${Math.floor(Math.random() * 1000)}`],
    );
    const solicitud = await c.query(
      `INSERT INTO solicitud (dispositivo_cliente_id, telefono_cliente,
         referencia_origen_id, referencia_destino_id, estado, conductor_id, clave_idempotencia)
       VALUES ($1, '+240222000111', $2, $3, 'CLIENTE_AUSENTE', $4, $5) RETURNING id`,
      [dispositivoId, origenId, destinoId, conductor.rows[0].id, randomUUID()],
    );
    const viaje = await c.query(
      `INSERT INTO viaje (solicitud_id, conductor_id, pin) VALUES ($1, $2, '1234') RETURNING id`,
      [solicitud.rows[0].id, conductor.rows[0].id],
    );
    const viajeId: number = viaje.rows[0].id;

    // La vía real: cliente ausente CON sesión activa → incidencia, sin strike.
    const resultado = await procesarClienteAusente(c, viajeId, true);
    assert.equal(resultado.strikeAplicado, false, 'con sesión activa jamás se sanciona solo');

    const incidencia = await c.query(
      'SELECT id FROM incidencia WHERE viaje_id = $1',
      [viajeId],
    );
    return { incidenciaId: incidencia.rows[0].id, dispositivoId, viajeId };
  });
}

test('operador: sin el uuid en la lista, 403 en todas las rutas', async () => {
  const intruso = randomUUID();
  for (const url of ['/api/operador/estadisticas', '/api/operador/incidencias', '/api/operador/pasajeros']) {
    const res = await app.inject({ method: 'GET', url, headers: cabeceras(intruso) });
    assert.equal(res.statusCode, 403, `${url} debería negarse`);
  }
});

test('incidencias: la cola lista el caso con su contexto y sancionar aplica el strike', async () => {
  // La base de desarrollo arrastra incidencias pendientes de baterías
  // anteriores (P12-03) que sacarían a la nuestra del LIMIT de la cola: se
  // dan por revisadas antes de empezar.
  await pool.query(
    `UPDATE incidencia SET resuelta_por = 'prueba-limpieza', resuelta_en = now(),
       resolucion = 'perdonado'
     WHERE resuelta_en IS NULL`,
  );
  const { incidenciaId, dispositivoId } = await crearIncidencia();

  const cola = await app.inject({
    method: 'GET', url: '/api/operador/incidencias', headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(cola.statusCode, 200);
  // pg devuelve los bigint como texto: se compara en número.
  const enCola = cola.json().incidencias.find((i: { id: string }) => Number(i.id) === Number(incidenciaId));
  assert.ok(enCola, 'la incidencia recién creada tiene que estar en la cola');
  assert.equal(enCola.tipo, 'no_presentado_dudoso');
  assert.equal(enCola.origen, 'Origen OP');
  assert.equal(enCola.conductor, 'Conductor OP');

  const resuelta = await app.inject({
    method: 'POST',
    url: `/api/operador/incidencias/${incidenciaId}/resolver`,
    headers: cabeceras(UUID_OPERADOR),
    payload: { accion: 'sancionar' },
  });
  assert.equal(resuelta.statusCode, 200, resuelta.body);
  assert.equal(resuelta.json().resolucion, 'sancionado');
  assert.equal(resuelta.json().strikes, 1);

  const dispositivo = await pool.query('SELECT strikes FROM dispositivo WHERE id = $1', [dispositivoId]);
  assert.equal(dispositivo.rows[0].strikes, 1, 'el strike tiene que llegar al dispositivo');

  // Resolver dos veces no sanciona dos veces.
  const repetida = await app.inject({
    method: 'POST',
    url: `/api/operador/incidencias/${incidenciaId}/resolver`,
    headers: cabeceras(UUID_OPERADOR),
    payload: { accion: 'sancionar' },
  });
  assert.equal(repetida.statusCode, 409);
});

test('incidencias: perdonar resuelve sin tocar los strikes, y el historial enseña el log', async () => {
  const { incidenciaId, dispositivoId } = await crearIncidencia();

  const resuelta = await app.inject({
    method: 'POST',
    url: `/api/operador/incidencias/${incidenciaId}/resolver`,
    headers: cabeceras(UUID_OPERADOR),
    payload: { accion: 'perdonar' },
  });
  assert.equal(resuelta.statusCode, 200, resuelta.body);
  assert.equal(resuelta.json().resolucion, 'perdonado');

  const dispositivo = await pool.query('SELECT strikes FROM dispositivo WHERE id = $1', [dispositivoId]);
  assert.equal(dispositivo.rows[0].strikes, 0, 'perdonar no puede sancionar');

  const historial = await app.inject({
    method: 'GET',
    url: `/api/operador/incidencias/${incidenciaId}/historial`,
    headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(historial.statusCode, 200);
  assert.ok(Array.isArray(historial.json().transiciones));
});

test('pasajeros: se busca por teléfono, la ficha trae su historial y desbloquear pone el contador a cero', async () => {
  const uuid = randomUUID();
  const telefono = `555${Date.now() % 1_000_000_000}`;
  // Alta de pasajero por la vía normal de la API.
  const alta = await app.inject({
    method: 'PUT', url: '/api/perfil', headers: cabeceras(uuid),
    payload: { telefono, correo: null },
  });
  assert.equal(alta.statusCode, 200, alta.body);

  const busqueda = await app.inject({
    method: 'GET',
    url: `/api/operador/pasajeros?q=${telefono}`,
    headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(busqueda.statusCode, 200);
  const encontrado = busqueda.json().pasajeros[0];
  assert.ok(encontrado, 'el pasajero recién creado debería aparecer');
  assert.equal(encontrado.telefono, telefono);

  // Se le bloquea a mano (como haría el sistema al tercer strike)…
  await pool.query(
    `UPDATE dispositivo SET strikes = 3, bloqueado_en = now() WHERE id = $1`,
    [encontrado.dispositivo_id],
  );
  const ficha = await app.inject({
    method: 'GET',
    url: `/api/operador/pasajeros/${encontrado.dispositivo_id}`,
    headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(ficha.statusCode, 200);
  assert.equal(ficha.json().strikes, 3);
  assert.notEqual(ficha.json().bloqueado_en, null);

  // …y el operador lo perdona.
  const desbloqueo = await app.inject({
    method: 'POST',
    url: `/api/operador/pasajeros/${encontrado.dispositivo_id}/desbloquear`,
    headers: cabeceras(UUID_OPERADOR),
    payload: {},
  });
  assert.equal(desbloqueo.statusCode, 200);
  assert.equal(desbloqueo.json().strikes, 0);
  assert.equal(desbloqueo.json().bloqueado_en, null);
});

test('conductores: la búsqueda por matrícula encuentra y la ficha trae vehículo, dinero e historial', async () => {
  const matricula = `GE-OP${Date.now() % 1_000_000}`;
  const conductorId = await enTransaccion(pool, async (c) => {
    const conductor = await c.query(
      `INSERT INTO conductor (telefono, nombre, estado_verificacion)
       VALUES ($1, 'Ficha Completa', 'verificado') RETURNING id`,
      [`+2402225${Date.now()}${Math.floor(Math.random() * 1000)}`],
    );
    await c.query(
      `INSERT INTO vehiculo (conductor_id, matricula, marca) VALUES ($1, $2, 'Toyota')`,
      [conductor.rows[0].id, matricula],
    );
    await c.query('INSERT INTO monedero (conductor_id) VALUES ($1)', [conductor.rows[0].id]);
    return conductor.rows[0].id as number;
  });

  const busqueda = await app.inject({
    method: 'GET',
    url: `/api/operador/conductores?q=${matricula}`,
    headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(busqueda.statusCode, 200);
  // pg devuelve los bigint como texto: se compara en número.
  assert.equal(Number(busqueda.json().conductores[0]?.id), Number(conductorId));

  const ficha = await app.inject({
    method: 'GET',
    url: `/api/operador/conductores/${conductorId}`,
    headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(ficha.statusCode, 200);
  const datos = ficha.json();
  assert.equal(datos.matricula, matricula);
  assert.equal(datos.saldo_xaf, 0);
  assert.equal(datos.suscripcionVigente, false);
  assert.equal(datos.viajes.completados, 0);
  assert.ok(Array.isArray(datos.ultimosViajes));
  assert.ok(Array.isArray(datos.recargas));
});
