// Batería del paso 8 (API del conductor). Requiere la base de datos de
// desarrollo arrancada (npm run bd:dev), migrada y con la semilla cargada.
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
import { recargar } from '../dominio/monedero.js';
import { ConexionesSse } from '../eventos/adaptador-sse.js';
import { crearServidor } from './servidor.js';


// Teléfono de pruebas que PUEDE existir: nueve dígitos locales, como los de
// Malabo. Los fixtures fabricaban antes números de dieciséis dígitos, que la
// validación vieja dejaba pasar porque solo miraba la longitud del texto.
// Arranca en un punto aleatorio y avanza de uno en uno: dentro de una
// ejecución no puede repetirse, y entre ejecuciones el solape es improbable.
// Con tres dígitos aleatorios sí chocaba —la base guarda los números de todas
// las ejecuciones anteriores (P12-03)— y reventaba el UNIQUE del teléfono.
let siguienteTelefono = Math.floor(Math.random() * 1_000_000);
function telefonoUnico(): string {
  siguienteTelefono = (siguienteTelefono + 1) % 1_000_000;
  return `+240222${String(siguienteTelefono).padStart(6, '0')}`;
}

let pool: pg.Pool;
let app: FastifyInstance;
let emisor: EmisorRegistro;
let conexionesSse: ConexionesSse;
let zonaId: number;
let origenId: number;
let destinoId: number;

before(async () => {
  pool = crearPool();
  emisor = new EmisorRegistro();
  conexionesSse = new ConexionesSse();
  app = crearServidor(pool, emisor, conexionesSse);
});

// Zona nueva por prueba: los conductores DISPONIBLE que dejan las pruebas
// anteriores en su zona competirían por la oleada 1 y el reparto dejaría de
// ser determinista.
async function crearEscenario(): Promise<void> {
  zonaId = (await enTransaccion(pool, (c) => crearZona(c, `Zona Conductor ${randomUUID()}`, 3.75, 8.78))).zonaId;
  origenId = (await enTransaccion(pool, (c) => guardarReferencia(c, {
    zonaId, nombre: 'Origen Conductor', lat: 3.75, lng: 8.78,
  }))).referenciaId;
  destinoId = (await enTransaccion(pool, (c) => guardarReferencia(c, {
    zonaId, nombre: 'Destino Conductor', lat: 3.751, lng: 8.781,
  }))).referenciaId;
}

after(async () => {
  await app.close();
  await pool.end();
});

interface ConductorPrueba {
  telefono: string;
  uuid: string;
  conductorId: number;
}

// Alta como la hará el operador (paso 9): conductor verificado con vehículo
// y saldo. Sin presencia: el registro de la app la crea si falta. El saldo
// por defecto cubre holgadamente la cuota semanal de 1.500 XAF.
async function darDeAlta(saldoXaf = 5000): Promise<ConductorPrueba> {
  const telefono = telefonoUnico();
  const conductorId = await enTransaccion(pool, async (c) => {
    const res = await c.query(
      `INSERT INTO conductor (telefono, nombre, estado_verificacion)
       VALUES ($1, 'Conductora App', 'verificado') RETURNING id`,
      [telefono],
    );
    const id: number = res.rows[0].id;
    await c.query(
      'INSERT INTO vehiculo (conductor_id, matricula) VALUES ($1, $2)',
      [id, `GE-${Date.now()}${Math.floor(Math.random() * 100000)}-C`],
    );
    await c.query('INSERT INTO monedero (conductor_id) VALUES ($1)', [id]);
    if (saldoXaf > 0) {
      await recargar(c, id, saldoXaf, `recarga-conductor-api-${randomUUID()}`);
    }
    return id;
  });
  return { telefono, uuid: randomUUID(), conductorId };
}

function cabeceras(uuid: string): Record<string, string> {
  return { 'x-dispositivo': uuid, 'content-type': 'application/json' };
}

async function llamar(
  metodo: 'GET' | 'POST',
  ruta: string,
  uuid: string,
  cuerpo?: unknown,
): Promise<{ codigo: number; json: any }> {
  const res = await app.inject({
    method: metodo,
    url: ruta,
    headers: metodo === 'GET' ? { 'x-dispositivo': uuid } : cabeceras(uuid),
    ...(metodo === 'GET' ? {} : { payload: (cuerpo ?? {}) as Record<string, unknown> }),
  });
  return { codigo: res.statusCode, json: res.json() };
}

async function registrarYConectar(conductor: ConductorPrueba): Promise<void> {
  const registro = await llamar('POST', '/api/conductor/registro', conductor.uuid, {
    telefono: conductor.telefono,
    fcmToken: `token-prueba-${conductor.uuid}`,
  });
  assert.equal(registro.codigo, 200, JSON.stringify(registro.json));
  // Sin suscripción vigente no llegan broadcasts (migración 011).
  const suscripcion = await llamar('POST', '/api/conductor/suscripcion', conductor.uuid);
  assert.equal(suscripcion.codigo, 200, JSON.stringify(suscripcion.json));
  const servicio = await llamar('POST', '/api/conductor/servicio', conductor.uuid, {
    enServicio: true,
    zonaId,
  });
  assert.equal(servicio.codigo, 200, JSON.stringify(servicio.json));
}

async function pedirTaxi(coordenadas?: { lat: number; lng: number }): Promise<{ solicitudId: number; uuidCliente: string }> {
  const uuidCliente = randomUUID();
  const res = await app.inject({
    method: 'POST',
    url: '/api/solicitudes',
    headers: cabeceras(uuidCliente),
    payload: { telefono: '+240222888777', origenId, destinoId, ...(coordenadas ?? {}) },
  });
  assert.ok(res.statusCode < 300, res.body);
  const json = res.json();
  assert.equal(json.estado, 'EMITIDO', 'la solicitud debe emitirse (¿conductor conectado?)');
  return { solicitudId: json.solicitudId, uuidCliente };
}

test('registro: teléfono sin alta → 404; con alta → datos y saldo; re-registro idempotente', async () => {
  const sinAlta = await llamar('POST', '/api/conductor/registro', randomUUID(), {
    telefono: '+240222000000',
  });
  assert.equal(sinAlta.codigo, 404);
  assert.match(sinAlta.json.error, /alta/);

  const conductor = await darDeAlta(1500);
  const registro = await llamar('POST', '/api/conductor/registro', conductor.uuid, {
    telefono: conductor.telefono,
    fcmToken: 'token-1',
  });
  assert.equal(registro.codigo, 200);
  assert.equal(registro.json.nombre, 'Conductora App');
  assert.equal(registro.json.saldoXaf, 1500);
  assert.equal(registro.json.estado, 'DESCONECTADO');

  const repetido = await llamar('POST', '/api/conductor/registro', conductor.uuid, {
    telefono: conductor.telefono,
    fcmToken: 'token-2',
  });
  assert.equal(repetido.codigo, 200);
  const dispositivo = await pool.query(
    'SELECT fcm_token FROM dispositivo WHERE uuid_persistente = $1',
    [conductor.uuid],
  );
  assert.equal(dispositivo.rows[0].fcm_token, 'token-2');
});

test('registro: un dispositivo no puede cambiar de identidad', async () => {
  await crearEscenario();
  const uno = await darDeAlta();
  const otro = await darDeAlta();
  await registrarYConectar(uno);
  const suplantacion = await llamar('POST', '/api/conductor/registro', uno.uuid, {
    telefono: otro.telefono,
  });
  assert.equal(suplantacion.codigo, 409);
});

test('flujo completo por API: oferta sin teléfono → aceptar → salir revela teléfono → recogida → cierre', async () => {
  await crearEscenario();
  const conductor = await darDeAlta();
  await registrarYConectar(conductor);
  const { solicitudId } = await pedirTaxi();

  // La oferta llega al estado del conductor: destino y banda, JAMÁS el teléfono.
  const estado1 = await llamar('GET', '/api/conductor/estado', conductor.uuid);
  assert.equal(estado1.json.ofertas.length, 1);
  assert.equal(estado1.json.ofertas[0].solicitudId, solicitudId);
  assert.equal(estado1.json.ofertas[0].origen, 'Origen Conductor');
  assert.ok(!JSON.stringify(estado1.json.ofertas).includes('+240222888777'));

  const aceptar = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/aceptar`, conductor.uuid);
  assert.equal(aceptar.codigo, 200);
  assert.equal(aceptar.json.gano, true);
  assert.ok(!JSON.stringify(aceptar.json).includes('+240222888777'), 'el teléfono no se revela al aceptar (R3)');

  // Con el viaje ACEPTADO, el estado sigue sin teléfono. Taxi compartido: el
  // estado devuelve la LISTA de pasajeros, aquí con uno solo y 3 plazas libres.
  const estado2 = await llamar('GET', '/api/conductor/estado', conductor.uuid);
  assert.equal(estado2.json.pasajeros.length, 1);
  assert.equal(estado2.json.pasajeros[0].estado, 'ACEPTADO');
  assert.equal(estado2.json.pasajeros[0].telefonoCliente, null);
  assert.equal(estado2.json.plazas, 4);
  assert.equal(estado2.json.plazasLibres, 3);
  assert.equal(estado2.json.pasajerosABordo, 0);

  // La revelación es la confirmación de salida (R3).
  const salir = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/salir`, conductor.uuid);
  assert.equal(salir.codigo, 200);
  assert.equal(salir.json.telefonoCliente, '+240222888777');

  // «He llegado» arranca el reloj; declarar ausencia antes de agotarlo, 409.
  const llegado = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/he-llegado`, conductor.uuid);
  assert.equal(llegado.codigo, 200);
  assert.equal(llegado.json.relojEsperaSeg, 300);
  const prematuro = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/cliente-ausente`, conductor.uuid);
  assert.equal(prematuro.codigo, 409);
  assert.match(prematuro.json.error, /quedan \d+ segundos/);

  // PIN incorrecto cuando se envía → 400; confirmación manual sin PIN → 200.
  const pinMalo = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/recoger`, conductor.uuid, { pin: '0000' });
  assert.equal(pinMalo.codigo, 400);
  assert.match(pinMalo.json.error, /PIN incorrecto/);
  const recoger = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/recoger`, conductor.uuid);
  assert.equal(recoger.codigo, 200, JSON.stringify(recoger.json));

  // Cierre sin precio (migración 012) y sin comisión: el saldo solo refleja
  // la cuota de suscripción (5000 - 1500 = 3500).
  const completar = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/completar`, conductor.uuid);
  assert.equal(completar.codigo, 200, JSON.stringify(completar.json));
  assert.equal(completar.json.saldoXaf, 3500);
  const presencia = await pool.query(
    'SELECT estado FROM presencia WHERE conductor_id = $1',
    [conductor.conductorId],
  );
  assert.equal(presencia.rows[0].estado, 'DISPONIBLE');
});

test('cliente ausente con reloj agotado: strike al dispositivo del cliente', async () => {
  await crearEscenario();
  const conductor = await darDeAlta();
  await registrarYConectar(conductor);
  const { solicitudId, uuidCliente } = await pedirTaxi();

  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/aceptar`, conductor.uuid);
  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/salir`, conductor.uuid);
  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/he-llegado`, conductor.uuid);
  // Reloj agotado hace rato (retro-datado; en producción son 5 minutos reales).
  await pool.query(
    `UPDATE viaje SET llegado_en = now() - interval '6 minutes' WHERE solicitud_id = $1`,
    [solicitudId],
  );

  const ausente = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/cliente-ausente`, conductor.uuid);
  assert.equal(ausente.codigo, 200, JSON.stringify(ausente.json));
  assert.equal(ausente.json.revisionManual, false); // sin sesión SSE viva

  const solicitud = await pool.query('SELECT estado FROM solicitud WHERE id = $1', [solicitudId]);
  assert.equal(solicitud.rows[0].estado, 'CLIENTE_AUSENTE');
  const dispositivo = await pool.query(
    'SELECT strikes FROM dispositivo WHERE uuid_persistente = $1',
    [uuidCliente],
  );
  assert.equal(dispositivo.rows[0].strikes, 1);
  const presencia = await pool.query(
    'SELECT estado FROM presencia WHERE conductor_id = $1',
    [conductor.conductorId],
  );
  assert.equal(presencia.rows[0].estado, 'DISPONIBLE');
});

test('cliente ausente con sesión SSE viva: revisión manual, sin strike (R4)', async () => {
  await crearEscenario();
  const conductor = await darDeAlta();
  await registrarYConectar(conductor);
  const { solicitudId, uuidCliente } = await pedirTaxi();

  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/aceptar`, conductor.uuid);
  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/salir`, conductor.uuid);
  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/he-llegado`, conductor.uuid);
  await pool.query(
    `UPDATE viaje SET llegado_en = now() - interval '6 minutes' WHERE solicitud_id = $1`,
    [solicitudId],
  );

  // El cliente está mirando la pantalla: sesión SSE viva en este momento.
  const dispositivoCliente = await pool.query(
    'SELECT id FROM dispositivo WHERE uuid_persistente = $1',
    [uuidCliente],
  );
  const baja = conexionesSse.suscribir(dispositivoCliente.rows[0].id, () => undefined);
  const ausente = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/cliente-ausente`, conductor.uuid);
  baja();

  assert.equal(ausente.codigo, 200);
  assert.equal(ausente.json.revisionManual, true);
  const dispositivo = await pool.query(
    'SELECT strikes FROM dispositivo WHERE uuid_persistente = $1',
    [uuidCliente],
  );
  assert.equal(dispositivo.rows[0].strikes, 0, 'nunca sanción automática con sesión activa');
});

test('GPS antifraude: las lecturas se guardan y la distancia se calcula, sin bloquear jamás', async () => {
  await crearEscenario();
  const conductor = await darDeAlta();
  await registrarYConectar(conductor);
  // El cliente dio permiso: su lectura viaja con la solicitud.
  const { solicitudId } = await pedirTaxi({ lat: 3.7501, lng: 8.7801 });

  const solicitud = await pool.query(
    'SELECT lat_cliente, lng_cliente FROM solicitud WHERE id = $1',
    [solicitudId],
  );
  assert.equal(Number(solicitud.rows[0].lat_cliente), 3.7501);

  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/aceptar`, conductor.uuid);
  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/salir`, conductor.uuid);
  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/he-llegado`, conductor.uuid, {
    lat: 3.7502, lng: 8.7802,
  });

  // El conductor valida desde MUY lejos (≈5,5 km): la validación NO se
  // bloquea (decisión de sesión), pero la discrepancia queda registrada
  // para el paso 10.
  const viajePin = await pool.query('SELECT pin FROM viaje WHERE solicitud_id = $1', [solicitudId]);
  const recoger = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/recoger`, conductor.uuid, {
    pin: viajePin.rows[0].pin, lat: 3.80, lng: 8.78,
  });
  assert.equal(recoger.codigo, 200);
  assert.ok(recoger.json.distanciaValidacionM > 5000);

  const viaje = await pool.query(
    `SELECT lat_llegada, lat_validacion, distancia_validacion_m, validado_en
     FROM viaje WHERE solicitud_id = $1`,
    [solicitudId],
  );
  assert.equal(Number(viaje.rows[0].lat_llegada), 3.7502);
  assert.equal(Number(viaje.rows[0].lat_validacion), 3.80);
  assert.ok(Number(viaje.rows[0].distancia_validacion_m) > 5000);
  assert.notEqual(viaje.rows[0].validado_en, null);
});

test('GPS ausente: todo funciona igual sin coordenadas', async () => {
  await crearEscenario();
  const conductor = await darDeAlta();
  await registrarYConectar(conductor);
  const { solicitudId } = await pedirTaxi(); // sin permiso de ubicación

  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/aceptar`, conductor.uuid);
  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/salir`, conductor.uuid);
  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/he-llegado`, conductor.uuid);
  const viajePin = await pool.query('SELECT pin FROM viaje WHERE solicitud_id = $1', [solicitudId]);
  const recoger = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/recoger`, conductor.uuid, {
    pin: viajePin.rows[0].pin,
  });
  assert.equal(recoger.codigo, 200);
  assert.equal(recoger.json.distanciaValidacionM, null);
});

test('suscripción: la cuota se cobra del monedero, extiende 7 días y sin saldo es un 402 claro', async () => {
  await crearEscenario();
  const conductor = await darDeAlta(2000);
  await llamar('POST', '/api/conductor/registro', conductor.uuid, { telefono: conductor.telefono });

  const primera = await llamar('POST', '/api/conductor/suscripcion', conductor.uuid);
  assert.equal(primera.codigo, 200);
  assert.equal(primera.json.saldoXaf, 500); // 2000 - 1500
  const hasta1 = new Date(primera.json.suscritoHasta).getTime();
  assert.ok(hasta1 > Date.now() + 6.9 * 86_400_000 && hasta1 < Date.now() + 7.1 * 86_400_000);

  // Renovar de nuevo: sin saldo para la segunda cuota, 402 y vigencia intacta.
  const segunda = await llamar('POST', '/api/conductor/suscripcion', conductor.uuid);
  assert.equal(segunda.codigo, 402);
  assert.match(segunda.json.error, /Recarga el monedero/);
  const fila = await pool.query(
    'SELECT suscrito_hasta FROM conductor WHERE id = $1',
    [conductor.conductorId],
  );
  assert.equal(new Date(fila.rows[0].suscrito_hasta).getTime(), hasta1);
});

test('saldo bajo tras completar: se emite D4', async () => {
  await crearEscenario();
  const conductor = await darDeAlta(1600); // tras la cuota de 1500 quedará 100 < 300
  await registrarYConectar(conductor);
  const { solicitudId } = await pedirTaxi();

  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/aceptar`, conductor.uuid);
  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/salir`, conductor.uuid);
  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/recoger`, conductor.uuid);
  const completar = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/completar`, conductor.uuid);
  assert.equal(completar.json.saldoXaf, 100);
  assert.ok(emisor.deTipo('D4_saldo_bajo')
    .some((e) => e.conductorId === conductor.conductorId && e.datos.saldoXaf === 100));
});
