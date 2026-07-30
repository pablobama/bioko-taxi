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

// --- Bloques 1, 4, 5 y 6 (cuadro de mandos, central, gazetteer, precios) ----

// Zona nueva con sus dos referencias, para no pisar datos de otras pruebas.
async function crearZonaConReferencias(): Promise<{
  zonaId: number; origenId: number; destinoId: number;
}> {
  return enTransaccion(pool, async (c) => {
    const { zonaId } = await crearZona(c, `Zona BLQ ${randomUUID()}`, 3.75, 8.78);
    const { referenciaId: origenId } = await guardarReferencia(c, {
      zonaId, nombre: 'Origen BLQ', lat: 3.75, lng: 8.78,
    });
    const { referenciaId: destinoId } = await guardarReferencia(c, {
      zonaId, nombre: 'Destino BLQ', lat: 3.751, lng: 8.781,
    });
    return { zonaId, origenId, destinoId };
  });
}

test('salud: el cuadro de mandos evalúa las alarmas y detecta la zona que se queda sin taxi', async () => {
  const { zonaId, origenId, destinoId } = await crearZonaConReferencias();
  const nombreZona = await pool.query('SELECT nombre FROM zona WHERE id = $1', [zonaId]);

  // Cinco peticiones fallidas en 24 h en la misma zona: 100 % sin taxi, muy
  // por encima del umbral (0,30). Es exactamente lo que la alarma vigila.
  await enTransaccion(pool, async (c) => {
    const d = await c.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES ($1, 'cliente') RETURNING id`,
      [randomUUID()],
    );
    for (let i = 0; i < 5; i += 1) {
      await c.query(
        `INSERT INTO solicitud (dispositivo_cliente_id, telefono_cliente,
           referencia_origen_id, referencia_destino_id, estado, clave_idempotencia)
         VALUES ($1, '+240222000222', $2, $3, 'SIN_OFERTA', $4)`,
        [d.rows[0].id, origenId, destinoId, randomUUID()],
      );
    }
  });

  const salud = await app.inject({
    method: 'GET', url: '/api/operador/salud', headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(salud.statusCode, 200, salud.body);
  const datos = salud.json();
  assert.ok(Array.isArray(datos.taxisPorZona));
  assert.equal(datos.alarmas.length, 5, 'las cinco alarmas de la sección 11');

  const sinTaxi = datos.alarmas.find((a: { clave: string }) => a.clave === 'alarma_tasa_sin_oferta_max');
  assert.equal(sinTaxi.disparada, true);
  const zona = sinTaxi.detalle.find((f: { nombre: string }) => f.nombre === nombreZona.rows[0].nombre);
  assert.ok(zona, 'la zona con 5 fallos tiene que estar en el detalle');
  assert.equal(zona.tasa, 1);

  const mensajeria = datos.alarmas.find((a: { clave: string }) => a.clave === 'alarma_coste_mensajeria_xaf');
  assert.equal(mensajeria.disparada, false, 'sin fuente de datos no hay alarma');
});

test('central: crear una solicitud por teléfono le da dispositivo propio al que llama y es idempotente', async () => {
  const { origenId, destinoId } = await crearZonaConReferencias();
  const telefono = `+240333${Date.now() % 1000000}${Math.floor(Math.random() * 100)}`;

  const primera = await app.inject({
    method: 'POST', url: '/api/operador/solicitudes', headers: cabeceras(UUID_OPERADOR),
    payload: { telefono, origenId, destinoId },
  });
  assert.equal(primera.statusCode, 201, primera.body);
  // Zona recién creada y vacía: SIN_OFERTA inmediato (R1), que es la
  // respuesta honesta que el operador dicta por teléfono.
  assert.equal(primera.json().estado, 'SIN_OFERTA');

  // El teléfono quedó con dispositivo sintético y perfil.
  const perfil = await pool.query(
    `SELECT d.tipo FROM perfil_cliente pc JOIN dispositivo d ON d.id = pc.dispositivo_id
     WHERE pc.telefono = $1`,
    [telefono],
  );
  assert.equal(perfil.rowCount, 1);
  assert.equal(perfil.rows[0].tipo, 'cliente');

  // Repetir dentro de la ventana: la misma solicitud, no un segundo taxi.
  const repetida = await app.inject({
    method: 'POST', url: '/api/operador/solicitudes', headers: cabeceras(UUID_OPERADOR),
    payload: { telefono, origenId, destinoId },
  });
  assert.equal(repetida.statusCode, 200);
  assert.equal(repetida.json().yaExistia, true);
  assert.equal(Number(repetida.json().solicitudId), Number(primera.json().solicitudId));

  // Y aparece en el listado de la central.
  const lista = await app.inject({
    method: 'GET', url: '/api/operador/solicitudes', headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(lista.statusCode, 200);
  assert.ok(
    lista.json().solicitudes.some((s: { id: string }) => Number(s.id) === Number(primera.json().solicitudId)),
    'la solicitud de la central tiene que salir en su listado',
  );
});

test('gazetteer: crear, desactivar (visible para el operador), alias y su quitado ruidoso', async () => {
  const { zonaId } = await crearZonaConReferencias();
  const nombre = `Bar Nuevo ${Date.now()}`;

  const creada = await app.inject({
    method: 'POST', url: '/api/operador/referencias', headers: cabeceras(UUID_OPERADOR),
    payload: { zonaId, nombre, lat: 3.752, lng: 8.782, categoria: 'restaurante' },
  });
  assert.equal(creada.statusCode, 200, creada.body);
  const referenciaId = creada.json().referenciaId;

  const alias = await app.inject({
    method: 'POST', url: `/api/operador/referencias/${referenciaId}/alias`,
    headers: cabeceras(UUID_OPERADOR), payload: { alias: 'donde manolo' },
  });
  assert.equal(alias.statusCode, 200);

  const desactivada = await app.inject({
    method: 'POST', url: `/api/operador/referencias/${referenciaId}`,
    headers: cabeceras(UUID_OPERADOR), payload: { activa: false },
  });
  assert.equal(desactivada.statusCode, 200);

  // El buscador del operador la sigue viendo (para poder reactivarla), con
  // su alias y su estado a la vista. Se encuentra también POR el alias.
  const buscada = await app.inject({
    method: 'GET', url: '/api/operador/referencias?q=donde%20manolo',
    headers: cabeceras(UUID_OPERADOR),
  });
  const fila = buscada.json().referencias.find(
    (r: { id: string }) => Number(r.id) === Number(referenciaId),
  );
  assert.ok(fila, 'el operador tiene que encontrar referencias inactivas');
  assert.equal(fila.activa, false);
  assert.equal(fila.categoria, 'restaurante');
  assert.deepEqual(fila.alias, ['donde manolo']);

  const quitado = await app.inject({
    method: 'POST', url: `/api/operador/referencias/${referenciaId}/alias`,
    headers: cabeceras(UUID_OPERADOR), payload: { alias: 'donde manolo', quitar: true },
  });
  assert.equal(quitado.statusCode, 200);
  const quitarDeNuevo = await app.inject({
    method: 'POST', url: `/api/operador/referencias/${referenciaId}/alias`,
    headers: cabeceras(UUID_OPERADOR), payload: { alias: 'donde manolo', quitar: true },
  });
  assert.equal(quitarDeNuevo.statusCode, 409, 'quitar un alias inexistente es error ruidoso');
});

test('bandas de precio: el desorden se rechaza, el upsert actualiza y borrar borra', async () => {
  const { zonaId } = await crearZonaConReferencias();
  const { zonaId: otraZona } = await crearZonaConReferencias();

  const desordenada = await app.inject({
    method: 'POST', url: '/api/operador/bandas', headers: cabeceras(UUID_OPERADOR),
    payload: { zonaOrigenId: zonaId, zonaDestinoId: otraZona, p25: 900, p50: 500, p75: 1200 },
  });
  assert.equal(desordenada.statusCode, 400);

  const buena = await app.inject({
    method: 'POST', url: '/api/operador/bandas', headers: cabeceras(UUID_OPERADOR),
    payload: { zonaOrigenId: zonaId, zonaDestinoId: otraZona, p25: 500, p50: 800, p75: 1200 },
  });
  assert.equal(buena.statusCode, 200, buena.body);

  const actualizada = await app.inject({
    method: 'POST', url: '/api/operador/bandas', headers: cabeceras(UUID_OPERADOR),
    payload: { zonaOrigenId: zonaId, zonaDestinoId: otraZona, p25: 600, p50: 900, p75: 1300 },
  });
  assert.equal(actualizada.statusCode, 200);

  const lista = await app.inject({
    method: 'GET', url: '/api/operador/bandas', headers: cabeceras(UUID_OPERADOR),
  });
  const banda = lista.json().bandas.find(
    (b: { zona_origen_id: string }) => Number(b.zona_origen_id) === Number(zonaId),
  );
  assert.equal(Number(banda.p50), 900, 'el upsert tiene que actualizar, no duplicar');

  const borrada = await app.inject({
    method: 'POST', url: '/api/operador/bandas', headers: cabeceras(UUID_OPERADOR),
    payload: { zonaOrigenId: zonaId, zonaDestinoId: otraZona, borrar: true },
  });
  assert.equal(borrada.statusCode, 200);
  const despues = await app.inject({
    method: 'GET', url: '/api/operador/bandas', headers: cabeceras(UUID_OPERADOR),
  });
  assert.ok(!despues.json().bandas.some(
    (b: { zona_origen_id: string }) => Number(b.zona_origen_id) === Number(zonaId),
  ));
});

test('parámetros: se listan con descripción, se actualizan, y los inventados dan 404', async () => {
  const lista = await app.inject({
    method: 'GET', url: '/api/operador/parametros', headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(lista.statusCode, 200);
  const alarma = lista.json().parametros.find(
    (p: { clave: string }) => p.clave === 'alarma_coste_mensajeria_xaf',
  );
  assert.ok(alarma?.descripcion, 'cada parámetro lleva su descripción');
  const original = alarma.valor;

  try {
    const cambio = await app.inject({
      method: 'POST', url: '/api/operador/parametros/alarma_coste_mensajeria_xaf',
      headers: cabeceras(UUID_OPERADOR), payload: { valor: '26' },
    });
    assert.equal(cambio.statusCode, 200);
    assert.equal(cambio.json().valor, '26');
  } finally {
    // La base es compartida con las pruebas manuales: se deja como estaba.
    await pool.query(
      `UPDATE parametro SET valor = $1 WHERE clave = 'alarma_coste_mensajeria_xaf'`,
      [original],
    );
  }

  const inventado = await app.inject({
    method: 'POST', url: '/api/operador/parametros/parametro_que_no_existe',
    headers: cabeceras(UUID_OPERADOR), payload: { valor: '1' },
  });
  assert.equal(inventado.statusCode, 404, 'crear parámetros desde el panel sería inventarse configuración');
});
