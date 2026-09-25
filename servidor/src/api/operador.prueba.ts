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
import { sinAvisoALaCiudad, sinTaxisDeTodaLaIsla } from '../dominio/ayuda-pruebas.js';
import { crearServidor } from './servidor.js';


// Teléfono de pruebas que PUEDE existir: nueve dígitos locales, como los de
// Malabo. Los fixtures fabricaban antes números de dieciséis dígitos, que la
// validación vieja dejaba pasar porque solo miraba la longitud del texto.
// Arranca en un punto aleatorio y avanza de uno en uno: dentro de una
// ejecución no puede repetirse, y entre ejecuciones el solape es improbable.
// OCHO dígitos, no seis. Con seis el espacio era de un millón y la base de
// desarrollo ya guardaba dieciséis mil números de ejecuciones anteriores
// (P12-03): la probabilidad de que una batería entera chocara pasó del 50 %, y
// dejó de ser un fallo intermitente para ser uno de todos los días.
let siguienteTelefono = Math.floor(Math.random() * 100_000_000);
function telefonoUnico(): string {
  siguienteTelefono = (siguienteTelefono + 1) % 100_000_000;
  return `+2406${String(siguienteTelefono).padStart(8, '0')}`;
}

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
      [telefonoUnico()],
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
  const telefono = telefonoUnico();
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
      [telefonoUnico()],
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
  // Cinco de la sección 11 más la de tarifa abusiva, que volvió a ser
  // posible con la migración 066 (R5, P12-02).
  assert.equal(datos.alarmas.length, 6, 'las cinco de la sección 11 y la de tarifa');
  assert.ok(
    datos.alarmas.some((a: { clave: string }) => a.clave === 'alarma_cobros_de_mas'),
    'la vigilancia de tarifa tiene que estar en el cuadro de mandos',
  );

  const sinTaxi = datos.alarmas.find((a: { clave: string }) => a.clave === 'alarma_tasa_sin_oferta_max');
  assert.equal(sinTaxi.disparada, true);
  const zona = sinTaxi.detalle.find((f: { nombre: string }) => f.nombre === nombreZona.rows[0].nombre);
  assert.ok(zona, 'la zona con 5 fallos tiene que estar en el detalle');
  assert.equal(zona.tasa, 1);

  const mensajeria = datos.alarmas.find((a: { clave: string }) => a.clave === 'alarma_coste_mensajeria_xaf');
  assert.equal(mensajeria.disparada, false, 'sin fuente de datos no hay alarma');
});

test('central: crear una solicitud por teléfono le da dispositivo propio al que llama y es idempotente', async () => {
  // Espera el corte R1 («zona recién creada y vacía»), así que necesita que no
  // haya taxistas de «toda la isla» en servicio ni aviso a la ciudad entera
  // (migración 064): ver `sinTaxisDeTodaLaIsla` y `sinAvisoALaCiudad`.
  await sinTaxisDeTodaLaIsla(pool, () => sinAvisoALaCiudad(pool, async () => {
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
  }));
});

// --- Migración 067: quién tocó los precios y los parámetros ----------------

test('cambiar una banda deja rastro de quién, cuándo y qué había antes', async () => {
  const { zonaId } = await crearZonaConReferencias();
  const otra = await crearZonaConReferencias();

  const poner = (p25: number, p50: number, p75: number) => app.inject({
    method: 'POST', url: '/api/operador/bandas', headers: cabeceras(UUID_OPERADOR),
    payload: { zonaOrigenId: zonaId, zonaDestinoId: otra.zonaId, p25, p50, p75 },
  });

  assert.equal((await poner(1000, 1500, 2000)).statusCode, 200);
  assert.equal((await poner(2000, 2500, 3000)).statusCode, 200);

  const cambios = await app.inject({
    method: 'GET', url: '/api/operador/cambios', headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(cambios.statusCode, 200);
  const mios = cambios.json().cambios.filter(
    (c: { clave: string }) => c.clave === `${zonaId}→${otra.zonaId}`,
  );
  assert.equal(mios.length, 2, 'los dos cambios, no solo el último');
  // El más reciente primero, y con lo que había antes: se puede deshacer sin
  // adivinar.
  assert.equal(mios[0].antes, '1000/1500/2000');
  assert.equal(mios[0].ahora, '2000/2500/3000');
  assert.equal(mios[1].antes, null, 'la primera vez no había nada');
  assert.equal(mios[0].quien, 'operador');
});

test('cambiar un parámetro también deja rastro', async () => {
  const antes = await app.inject({
    method: 'GET', url: '/api/operador/parametros', headers: cabeceras(UUID_OPERADOR),
  });
  const parametro = antes.json().parametros.find(
    (p: { clave: string }) => p.clave === 'oleada_2_seg',
  );
  const valorOriginal = parametro.valor;
  try {
    await app.inject({
      method: 'POST', url: '/api/operador/parametros/oleada_2_seg',
      headers: cabeceras(UUID_OPERADOR), payload: { valor: '22' },
    });
    const cambios = await app.inject({
      method: 'GET', url: '/api/operador/cambios', headers: cabeceras(UUID_OPERADOR),
    });
    const mio = cambios.json().cambios.find(
      (c: { clave: string; ahora: string }) => c.clave === 'oleada_2_seg' && c.ahora === '22',
    );
    assert.ok(mio, 'un parámetro cambia el comportamiento entero sin desplegar: tiene que constar');
    assert.equal(mio.antes, valorOriginal);
  } finally {
    await app.inject({
      method: 'POST', url: '/api/operador/parametros/oleada_2_seg',
      headers: cabeceras(UUID_OPERADOR), payload: { valor: valorOriginal },
    });
  }
});

test('el registro de cambios no se puede editar ni borrar', async () => {
  const { zonaId } = await crearZonaConReferencias();
  const otra = await crearZonaConReferencias();
  await app.inject({
    method: 'POST', url: '/api/operador/bandas', headers: cabeceras(UUID_OPERADOR),
    payload: { zonaOrigenId: zonaId, zonaDestinoId: otra.zonaId, p25: 100, p50: 200, p75: 300 },
  });
  // El mismo candado que `transicion` y `apunte`: un registro de auditoría que
  // se puede editar no es un registro de auditoría.
  await assert.rejects(
    () => pool.query(`UPDATE cambio_ajuste SET valor_nuevo = '0/0/0' WHERE clave = $1`,
      [`${zonaId}→${otra.zonaId}`]),
  );
  await assert.rejects(
    () => pool.query('DELETE FROM cambio_ajuste WHERE clave = $1', [`${zonaId}→${otra.zonaId}`]),
  );
});

test('el listado de cambios es solo del operador: quién vigila a los agentes no es un agente', async () => {
  const agente = await enTransaccion(pool, async (c) => {
    const conductor = await c.query(
      `INSERT INTO conductor (telefono, nombre, estado_verificacion, es_agente)
       VALUES ($1, 'Taxi CAM', 'verificado', true) RETURNING id`,
      [telefonoUnico()],
    );
    const uuid = randomUUID();
    await c.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id)
       VALUES ($1, 'conductor', $2)`,
      [uuid, conductor.rows[0].id],
    );
    return uuid;
  });
  const res = await app.inject({
    method: 'GET', url: '/api/operador/cambios', headers: cabeceras(agente),
  });
  assert.equal(res.statusCode, 403);
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

// Migración 038: un lugar se fija con las mismas reglas que un barrio.
test('un lugar puesto a mano queda marcado como sin verificar sobre el terreno', async () => {
  const { zonaId } = await crearZonaConReferencias();

  const aMano = await app.inject({
    method: 'POST', url: '/api/operador/referencias', headers: cabeceras(UUID_OPERADOR),
    payload: { zonaId, nombre: `Sitio a mano ${randomUUID()}`, lat: 3.752, lng: 8.782 },
  });
  assert.equal(aMano.statusCode, 200, aMano.body);
  const sinVerificar = await pool.query(
    'SELECT precision_gps_m FROM referencia WHERE id = $1',
    [aMano.json().referenciaId],
  );
  assert.equal(sinVerificar.rows[0].precision_gps_m, null);

  const conGps = await app.inject({
    method: 'POST', url: '/api/operador/referencias', headers: cabeceras(UUID_OPERADOR),
    payload: {
      zonaId, nombre: `Sitio con GPS ${randomUUID()}`,
      lat: 3.752, lng: 8.782, precision: 9,
    },
  });
  assert.equal(conGps.statusCode, 200, conGps.body);
  const verificado = await pool.query(
    'SELECT precision_gps_m FROM referencia WHERE id = $1',
    [conGps.json().referenciaId],
  );
  assert.equal(Number(verificado.rows[0].precision_gps_m), 9);
});

test('un lugar con el GPS demasiado impreciso se rechaza, como un barrio', async () => {
  const { zonaId } = await crearZonaConReferencias();
  const res = await app.inject({
    method: 'POST', url: '/api/operador/referencias', headers: cabeceras(UUID_OPERADOR),
    payload: {
      zonaId, nombre: `Sitio impreciso ${randomUUID()}`,
      lat: 3.752, lng: 8.782, precision: 900,
    },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /cielo abierto/);
});

test('un lugar fuera de Bioko se rechaza; dentro de la isla pero lejos de Malabo se acepta', async () => {
  const { zonaId } = await crearZonaConReferencias();

  const fuera = await app.inject({
    method: 'POST', url: '/api/operador/referencias', headers: cabeceras(UUID_OPERADOR),
    payload: { zonaId, nombre: `Sitio de Bata ${randomUUID()}`, lat: 1.86, lng: 9.77 },
  });
  assert.equal(fuera.statusCode, 400);
  assert.match(fuera.json().error, /fuera de Bioko/);

  // Luba, al suroeste: caía fuera del recuadro viejo de Malabo ciudad.
  const enLuba = await app.inject({
    method: 'POST', url: '/api/operador/referencias', headers: cabeceras(UUID_OPERADOR),
    payload: { zonaId, nombre: `Sitio de Luba ${randomUUID()}`, lat: 3.4561, lng: 8.5492 },
  });
  assert.equal(enLuba.statusCode, 200, enLuba.body);
});

// Migración 042: el recorrido de un taxi durante su turno.
test('el recorrido: lo ve el operador, no un agente de campo, y sale por tramos', async () => {
  const { conductorId, uuidAgente } = await enTransaccion(pool, async (c) => {
    const conductor = await c.query(
      `INSERT INTO conductor (telefono, nombre, estado_verificacion, es_agente)
       VALUES ($1, 'Taxi REC', 'verificado', true) RETURNING id`,
      [telefonoUnico()],
    );
    const conductorId: number = conductor.rows[0].id;
    const uuidAgente = randomUUID();
    await c.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id)
       VALUES ($1, 'conductor', $2)`,
      [uuidAgente, conductorId],
    );
    await c.query(
      `INSERT INTO presencia (conductor_id, estado, ultimo_heartbeat)
       VALUES ($1, 'DISPONIBLE', now())`,
      [conductorId],
    );
    // Dos puntos hace un rato y dos hace mucho menos: dos tramos.
    const hace = (min: number) => new Date(Date.now() - min * 60_000);
    await c.query(
      `INSERT INTO rastro (conductor_id, lat, lng, creado_en) VALUES
        ($1, 3.750, 8.780, $2), ($1, 3.753, 8.780, $3),
        ($1, 3.780, 8.800, $4), ($1, 3.783, 8.800, $5)`,
      [conductorId, hace(300), hace(299), hace(60), hace(59)],
    );
    return { conductorId, uuidAgente };
  });

  // Un agente de campo sitúa barrios; no le toca saber por dónde anduvo un
  // compañero. Esta ruta pide operador, no campo, y esto lo fija.
  const agente = await app.inject({
    method: 'GET', url: `/api/operador/conductores/${conductorId}/recorrido?periodo=dia`,
    headers: cabeceras(uuidAgente),
  });
  assert.equal(agente.statusCode, 403, 'un agente de campo no vigila a sus compañeros');

  const res = await app.inject({
    method: 'GET', url: `/api/operador/conductores/${conductorId}/recorrido?periodo=dia`,
    headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(res.statusCode, 200, res.body);
  const cuerpo = res.json();
  assert.equal(cuerpo.puntos, 4);
  assert.equal(cuerpo.tramos.length, 2, 'las cinco horas de hueco no se unen con una recta');
  assert.ok(cuerpo.metros > 300, `esperaba unos cientos de metros y salieron ${cuerpo.metros}`);

  // Un periodo que no existe se rechaza, en vez de caer en el de por defecto
  // y devolver un recorrido de otro plazo sin decirlo.
  const malo = await app.inject({
    method: 'GET', url: `/api/operador/conductores/${conductorId}/recorrido?periodo=trimestre`,
    headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(malo.statusCode, 400);
});

// --- Migración 061: el taxi del operador unificado con su taxista de verdad --

test('«Taxista» en el conmutador respeta la unificación y no resucita el taxi viejo', async () => {
  // El conmutador llama a mi-taxi CADA VEZ que se pulsa «Taxista». Antes de la
  // 061 eso buscaba el taxi del operador por su teléfono y le volvía a
  // enganchar el dispositivo: una unificación hecha con el script se habría
  // deshecho al primer cambio de papel.
  const uuidTaxi = randomUUID();
  const primera = await app.inject({
    method: 'POST', url: '/api/operador/mi-taxi',
    headers: cabeceras(UUID_OPERADOR), payload: { uuid: uuidTaxi },
  });
  assert.equal(primera.statusCode, 200, primera.body);
  const taxiOperador = Number(primera.json().conductorId);

  // Su taxista de verdad, con lo suyo.
  const real = await pool.query(
    `INSERT INTO conductor (telefono, nombre, estado_verificacion, suscrito_hasta)
     VALUES ($1, 'Pablo de verdad', 'verificado', now() + interval '10 days')
     RETURNING id, suscrito_hasta`,
    [telefonoUnico()],
  );
  const pablo = Number(real.rows[0].id);
  const suscripcionAntes = new Date(real.rows[0].suscrito_hasta).getTime();
  await pool.query('UPDATE conductor SET unificado_en = $2 WHERE id = $1', [taxiOperador, pablo]);

  // Pulsa «Taxista» otra vez.
  const segunda = await app.inject({
    method: 'POST', url: '/api/operador/mi-taxi',
    headers: cabeceras(UUID_OPERADOR), payload: { uuid: uuidTaxi },
  });
  assert.equal(segunda.statusCode, 200, segunda.body);
  assert.equal(Number(segunda.json().conductorId), pablo, 'el papel de taxista es ya el de Pablo');

  const dispositivo = await pool.query(
    'SELECT conductor_id FROM dispositivo WHERE uuid_persistente = $1', [uuidTaxi],
  );
  assert.equal(Number(dispositivo.rows[0].conductor_id), pablo);

  // Y a Pablo no se le toca nada: mi-taxi regala un año de suscripción al taxi
  // de pruebas que se inventa, no a un taxista de verdad.
  const despues = await pool.query('SELECT suscrito_hasta FROM conductor WHERE id = $1', [pablo]);
  assert.equal(new Date(despues.rows[0].suscrito_hasta).getTime(), suscripcionAntes);
});
