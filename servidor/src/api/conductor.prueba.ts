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
// OCHO dígitos, no seis. Con seis el espacio era de un millón y la base de
// desarrollo ya guardaba dieciséis mil números de ejecuciones anteriores
// (P12-03): la probabilidad de que una batería entera chocara pasó del 50 %, y
// dejó de ser un fallo intermitente para ser uno de todos los días.
let siguienteTelefono = Math.floor(Math.random() * 100_000_000);
function telefonoUnico(): string {
  siguienteTelefono = (siguienteTelefono + 1) % 100_000_000;
  return `+2406${String(siguienteTelefono).padStart(8, '0')}`;
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

// El barrio donde se entra en servicio lo dice el GPS, no el taxista. Antes
// se mandaba un `zonaId` de una lista y nada impedía declararse al otro lado
// de la ciudad, con lo que el pasajero recibía un taxi que no tenía cerca.
test('entrar en servicio con coordenadas: el barrio lo decide dónde está el coche', async () => {
  await crearEscenario();
  const conductor = await darDeAlta();
  await llamar('POST', '/api/conductor/registro', conductor.uuid, {
    telefono: conductor.telefono,
  });
  await llamar('POST', '/api/conductor/suscripcion', conductor.uuid);

  // Un barrio propio en un punto AL AZAR y lejos de Malabo, y se pregunta
  // por ese mismo punto exacto: a distancia cero no hay quien lo gane. Con
  // coordenadas fijas la prueba pasaba sola y fallaba en la batería, porque
  // la ejecución anterior dejaba otro barrio en el mismo sitio y dos
  // empatados a la misma distancia se ordenan como quieran (P12-03: la base
  // de desarrollo guarda lo de todas las ejecuciones).
  const lat = 3.30 + Math.random() * 0.05;
  const lng = 8.45 + Math.random() * 0.05;
  const lejano = await enTransaccion(pool, (c) => crearZona(
    c, `Zona Lejana ${randomUUID()}`, lat, lng,
  ));

  const servicio = await llamar('POST', '/api/conductor/servicio', conductor.uuid, {
    enServicio: true, lat, lng,
  });
  assert.equal(servicio.codigo, 200, JSON.stringify(servicio.json));
  assert.equal(Number(servicio.json.zonaId), Number(lejano.zonaId));

  const presencia = await pool.query(
    'SELECT zona_id FROM presencia WHERE conductor_id = $1',
    [conductor.conductorId],
  );
  assert.equal(Number(presencia.rows[0].zona_id), Number(lejano.zonaId));
});

test('entrar en servicio sin coordenadas ni zona: se rechaza con motivo', async () => {
  await crearEscenario();
  const conductor = await darDeAlta();
  await llamar('POST', '/api/conductor/registro', conductor.uuid, {
    telefono: conductor.telefono,
  });
  await llamar('POST', '/api/conductor/suscripcion', conductor.uuid);

  const servicio = await llamar('POST', '/api/conductor/servicio', conductor.uuid, {
    enServicio: true,
  });
  assert.equal(servicio.codigo, 400);
  assert.match(servicio.json.error ?? servicio.json.message ?? '', /dónde estás/);
});

// El barrio sigue al coche: quien entra en servicio en un sitio y se mueve a
// otro tiene que recibir las carreras de donde está, no las de donde empezó.
test('el latido mueve el barrio del conductor al que le corresponde por GPS', async () => {
  await crearEscenario();
  const conductor = await darDeAlta();
  await llamar('POST', '/api/conductor/registro', conductor.uuid, {
    telefono: conductor.telefono,
  });
  await llamar('POST', '/api/conductor/suscripcion', conductor.uuid);

  // Dos barrios al azar y lejos de todo, cada uno en su sitio: se pregunta
  // por su punto exacto, así que a distancia cero no hay empate posible.
  const salida = { lat: 3.30 + Math.random() * 0.02, lng: 8.45 + Math.random() * 0.02 };
  const llegada = { lat: 3.34 + Math.random() * 0.02, lng: 8.41 + Math.random() * 0.02 };
  const zonaSalida = await enTransaccion(pool, (c) => crearZona(
    c, `Zona Salida ${randomUUID()}`, salida.lat, salida.lng,
  ));
  const zonaLlegada = await enTransaccion(pool, (c) => crearZona(
    c, `Zona Llegada ${randomUUID()}`, llegada.lat, llegada.lng,
  ));

  const servicio = await llamar('POST', '/api/conductor/servicio', conductor.uuid, {
    enServicio: true, ...salida,
  });
  assert.equal(Number(servicio.json.zonaId), Number(zonaSalida.zonaId));

  const latido = await llamar('POST', '/api/conductor/heartbeat', conductor.uuid, llegada);
  assert.equal(latido.codigo, 200, JSON.stringify(latido.json));

  const presencia = await pool.query(
    'SELECT zona_id FROM presencia WHERE conductor_id = $1',
    [conductor.conductorId],
  );
  assert.equal(Number(presencia.rows[0].zona_id), Number(zonaLlegada.zonaId));
});

// --- Acciones hechas sin red (migración 057) -----------------------------

// Un viaje aceptado y con el taxista de camino, listo para las acciones.
async function viajeEnCamino(): Promise<{ conductor: ConductorPrueba; solicitudId: number; uuidCliente: string }> {
  await crearEscenario();
  const conductor = await darDeAlta();
  await registrarYConectar(conductor);
  const { solicitudId, uuidCliente } = await pedirTaxi();
  assert.equal((await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/aceptar`, conductor.uuid)).codigo, 200);
  assert.equal((await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/salir`, conductor.uuid)).codigo, 200);
  return { conductor, solicitudId, uuidCliente };
}

const haceMinutos = (m: number) => new Date(Date.now() - m * 60_000);

test('sin red: la acción llega tarde y se apunta con la hora en que se pulsó', async () => {
  await crearEscenario();
  const conductor = await darDeAlta();
  await registrarYConectar(conductor);
  const { solicitudId } = await pedirTaxi();
  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/aceptar`, conductor.uuid);
  // Sin cobertura desde que aceptó: «voy de camino» y «recogido» pulsados
  // sin red, y los dos llegan ahora, en orden. (La aceptación se apuntó hace
  // un instante, así que el servidor acercará las dos horas hasta ahí: lo que
  // se prueba es que, corrija lo que corrija, lo haga igual en todas partes.)
  const salida = haceMinutos(6);
  const recogida = haceMinutos(2);
  const ruta = `/api/conductor/solicitudes/${solicitudId}`;
  await llamar('POST', `${ruta}/salir`, conductor.uuid, { ocurridoEn: salida.toISOString() });
  const recoger = await llamar('POST', `${ruta}/recoger`, conductor.uuid, { ocurridoEn: recogida.toISOString() });
  assert.equal(recoger.codigo, 200, JSON.stringify(recoger.json));

  const r = await pool.query(
    `SELECT v.validado_en, t.ocurrio_en
     FROM viaje v JOIN transicion t ON t.solicitud_id = v.solicitud_id AND t.estado_nuevo = 'RECOGIDO'
     WHERE v.solicitud_id = $1`,
    [solicitudId],
  );
  // La hora de recogida del viaje y la del registro de estados son LA MISMA:
  // si solo se corrigiera una, el mismo hecho tendría dos horas.
  assert.equal(
    new Date(r.rows[0].validado_en).getTime(), new Date(r.rows[0].ocurrio_en).getTime(),
    'viaje y registro de estados dicen la misma hora',
  );
});

test('sin red: una hora anterior a lo ya apuntado se acerca, igual en todas partes', async () => {
  const { conductor, solicitudId } = await viajeEnCamino();
  // «Voy de camino» se apuntó hace un instante; llega un «recogido» que dice
  // ser de hace diez minutos. Recogido antes de salir no puede ser.
  const r = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/recoger`, conductor.uuid, {
    ocurridoEn: haceMinutos(10).toISOString(),
  });
  assert.equal(r.codigo, 200);
  const fila = await pool.query(
    `SELECT v.validado_en,
            (SELECT COALESCE(ocurrio_en, creado_en) FROM transicion
             WHERE solicitud_id = v.solicitud_id AND estado_nuevo = 'EN_CAMINO') AS salida,
            (SELECT ocurrio_en FROM transicion
             WHERE solicitud_id = v.solicitud_id AND estado_nuevo = 'RECOGIDO') AS recogida
     FROM viaje v WHERE v.solicitud_id = $1`,
    [solicitudId],
  );
  const { validado_en: validado, salida, recogida: recogidaLog } = fila.rows[0];
  assert.ok(new Date(validado) >= new Date(salida), 'la recogida no puede ser antes de salir');
  assert.equal(new Date(validado).getTime(), new Date(recogidaLog).getTime(), 'y la misma hora en los dos sitios');
});

test('sin red: repetir una acción ya hecha no es un error', async () => {
  const { conductor, solicitudId } = await viajeEnCamino();
  const ruta = `/api/conductor/solicitudes/${solicitudId}`;
  // La cola reenvía si no llegó la confirmación: la segunda vez tiene que dar
  // lo mismo, no un 409 que la aplicación enseñaría como fallo.
  for (const accion of ['salir', 'recoger', 'recoger', 'completar', 'completar']) {
    const r = await llamar('POST', `${ruta}/${accion}`, conductor.uuid);
    assert.equal(r.codigo, 200, `${accion}: ${JSON.stringify(r.json)}`);
  }
  const estado = await pool.query('SELECT estado FROM solicitud WHERE id = $1', [solicitudId]);
  assert.equal(estado.rows[0].estado, 'COMPLETADO');
});

test('sin red: si la proximidad ya recogió al pasajero, el «recogido» tardío no pisa nada', async () => {
  const { conductor, solicitudId } = await viajeEnCamino();
  // Mientras el taxista no tenía red, el sistema lo marcó recogido solo.
  await enTransaccion(pool, (c) => c.query(
    `UPDATE viaje SET validado_en = now() - interval '5 minutes' WHERE solicitud_id = $1`, [solicitudId],
  ));
  const { transicionarSolicitud } = await import('../dominio/transiciones.js');
  await enTransaccion(pool, (c) => transicionarSolicitud(c, solicitudId, 'RECOGIDO', 'sistema', 'proximidad_gps'));
  const antes = await pool.query('SELECT validado_en FROM viaje WHERE solicitud_id = $1', [solicitudId]);

  const tardio = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/recoger`, conductor.uuid, {
    ocurridoEn: haceMinutos(2).toISOString(),
  });
  assert.equal(tardio.codigo, 200);
  assert.equal(tardio.json.yaHecho, true);
  const despues = await pool.query('SELECT validado_en FROM viaje WHERE solicitud_id = $1', [solicitudId]);
  assert.equal(
    new Date(despues.rows[0].validado_en).getTime(), new Date(antes.rows[0].validado_en).getTime(),
    'la hora de recogida buena es la primera',
  );
});

test('sin red: una acción sobre un viaje que el pasajero canceló mientras tanto se rechaza', async () => {
  await crearEscenario();
  const conductor = await darDeAlta();
  await registrarYConectar(conductor);
  const { solicitudId } = await pedirTaxi();
  await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/aceptar`, conductor.uuid);
  // El pasajero canceló, y al taxista le llega tarde su «voy de camino».
  const { transicionarSolicitud } = await import('../dominio/transiciones.js');
  await enTransaccion(pool, (c) => transicionarSolicitud(c, solicitudId, 'CANCELADO_CLIENTE', 'cliente'));
  const salir = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/salir`, conductor.uuid, {
    ocurridoEn: haceMinutos(1).toISOString(),
  });
  assert.equal(salir.codigo, 409, 'no hay arreglo: la aplicación lo enseña y lo descarta');
});

test('sin red: una hora imposible no se cree', async () => {
  const { conductor, solicitudId } = await viajeEnCamino();
  // Un reloj de móvil con días de desfase, o del futuro.
  for (const ocurridoEn of [new Date(Date.now() + 3_600_000).toISOString(), haceMinutos(60 * 48).toISOString()]) {
    const { solicitudId: otra } = { solicitudId };
    void otra;
    const r = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/he-llegado`, conductor.uuid, { ocurridoEn });
    assert.equal(r.codigo, 200);
  }
  const viaje = await pool.query('SELECT llegado_en FROM viaje WHERE solicitud_id = $1', [solicitudId]);
  const llegado = new Date(viaje.rows[0].llegado_en).getTime();
  assert.ok(Math.abs(llegado - Date.now()) < 60_000, 'con una hora imposible manda el reloj del servidor');
});

test('sin red: el reloj de espera se mide contra cuándo se pulsó «no aparece»', async () => {
  const { conductor, solicitudId } = await viajeEnCamino();
  // Llegó hace media hora y declaró la ausencia hace veinte minutos, sin red.
  await pool.query(`UPDATE viaje SET llegado_en = now() - interval '30 minutes' WHERE solicitud_id = $1`, [solicitudId]);
  const r = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/cliente-ausente`, conductor.uuid, {
    ocurridoEn: haceMinutos(20).toISOString(),
  });
  assert.equal(r.codigo, 200, JSON.stringify(r.json));
  // Y como no se sabe si el pasajero estaba conectado ENTONCES, no hay sanción
  // automática: se revisa a mano.
  assert.equal(r.json.revisionManual, true);
});

test('sin red: salir de servicio dos veces no es un error', async () => {
  await crearEscenario();
  const conductor = await darDeAlta();
  await registrarYConectar(conductor);
  const pulsado = haceMinutos(15);
  const una = await llamar('POST', '/api/conductor/servicio', conductor.uuid, { enServicio: false, ocurridoEn: pulsado.toISOString() });
  const dos = await llamar('POST', '/api/conductor/servicio', conductor.uuid, { enServicio: false, ocurridoEn: pulsado.toISOString() });
  assert.equal(una.codigo, 200);
  assert.equal(dos.codigo, 200);
  assert.equal(dos.json.yaHecho, true);
});

// --- Notificaciones web (migración 058) -----------------------------------

test('el buzón de avisos se guarda, y uno incompleto se rechaza', async () => {
  const conductor = await darDeAlta();
  await registrarYConectar(conductor);

  const clave = await llamar('GET', '/api/conductor/notificaciones/clave', conductor.uuid);
  assert.equal(clave.codigo, 200);
  assert.ok(clave.json.clavePublica.length > 40, 'la clave pública viaja al navegador');

  // Un buzón sin sus claves no se puede cifrar: guardarlo solo serviría para
  // fallar en cada envío, así que se rechaza en la puerta.
  const incompleto = await llamar('POST', '/api/conductor/notificaciones', conductor.uuid, {
    endpoint: 'https://push.example/sin-claves',
  });
  assert.equal(incompleto.codigo, 400);

  const bueno = await llamar('POST', '/api/conductor/notificaciones', conductor.uuid, {
    endpoint: `https://push.example/${conductor.uuid}`,
    claves: { p256dh: 'clave', auth: 'auth' },
  });
  assert.equal(bueno.codigo, 200, JSON.stringify(bueno.json));

  const guardadas = await pool.query(
    `SELECT count(*)::int AS n FROM suscripcion_web s
     JOIN dispositivo d ON d.id = s.dispositivo_id
     WHERE d.conductor_id = $1`,
    [conductor.conductorId],
  );
  assert.equal(guardadas.rows[0].n, 1);
});

// --- 21/09: lo que vio el taxista que lo probó -----------------------------

async function dispositivoDelPasajero(uuid: string): Promise<number> {
  const res = await pool.query('SELECT id FROM dispositivo WHERE uuid_persistente = $1', [uuid]);
  return Number(res.rows[0].id);
}

test('«ya me bajé» cierra el viaje de verdad y libera la plaza', async () => {
  // Antes el botón solo limpiaba la pantalla del pasajero: el taxista seguía
  // con él a bordo, y con el coche lleno no le llegaban carreras.
  const { conductor, solicitudId, uuidCliente } = await viajeEnCamino();
  const recoger = await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/recoger`, conductor.uuid);
  assert.equal(recoger.codigo, 200, JSON.stringify(recoger.json));

  const bajar = await app.inject({
    method: 'POST',
    url: `/api/solicitudes/${solicitudId}/he-bajado`,
    headers: cabeceras(uuidCliente),
    payload: {},
  });
  assert.equal(bajar.statusCode, 200, bajar.body);

  const estado = await pool.query('SELECT estado FROM solicitud WHERE id = $1', [solicitudId]);
  assert.equal(estado.rows[0].estado, 'COMPLETADO');
  const quien = await pool.query(
    `SELECT actor, origen_evento FROM transicion
     WHERE solicitud_id = $1 AND estado_nuevo = 'COMPLETADO'`,
    [solicitudId],
  );
  assert.equal(quien.rows[0].actor, 'cliente', 'tiene que quedar escrito quién lo cerró');
  const presencia = await pool.query('SELECT estado FROM presencia WHERE conductor_id = $1', [conductor.conductorId]);
  assert.equal(presencia.rows[0].estado, 'DISPONIBLE', 'la plaza vuelve a estar libre');

  // Pulsarlo dos veces —o que llegue tarde desde la bandeja sin red— no es un
  // error: el viaje ya está cerrado.
  const otraVez = await app.inject({
    method: 'POST',
    url: `/api/solicitudes/${solicitudId}/he-bajado`,
    headers: cabeceras(uuidCliente),
    payload: {},
  });
  assert.equal(otraVez.statusCode, 200);
});

test('«ya me bajé» no cierra un viaje que no ha empezado', async () => {
  // Un pasajero que todavía espera en la acera no puede terminar nada: sería
  // una forma rara de cancelar, saltándose la gracia de la cancelación.
  const { solicitudId, uuidCliente } = await viajeEnCamino();
  const bajar = await app.inject({
    method: 'POST',
    url: `/api/solicitudes/${solicitudId}/he-bajado`,
    headers: cabeceras(uuidCliente),
    payload: {},
  });
  assert.equal(bajar.statusCode, 409);
});

test('la pantalla del pasajero se entera AL MOMENTO de que lo han recogido', async () => {
  // El retraso que se notaba: el taxista pulsa «recogido» y el pasajero lo veía
  // en el siguiente sondeo, diez o veinte segundos después. Ahora le llega un
  // empujón por la conexión que ya tiene abierta.
  const { conductor, solicitudId, uuidCliente } = await viajeEnCamino();
  const recibidos: string[] = [];
  const baja = conexionesSse.suscribir(await dispositivoDelPasajero(uuidCliente), (c) => recibidos.push(c));
  try {
    await llamar('POST', `/api/conductor/solicitudes/${solicitudId}/recoger`, conductor.uuid);
  } finally {
    baja();
  }
  assert.ok(
    recibidos.some((c) => JSON.parse(c).tipo === 'cambio_estado'),
    'el pasajero tenía que recibir el aviso de cambio en cuanto se recogió',
  );
});
