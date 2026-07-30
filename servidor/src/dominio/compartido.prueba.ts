// Batería del taxi compartido (migración 013). Requiere la base de datos de
// desarrollo arrancada, migrada y con la semilla cargada.
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { iniciarDespacho, reclamarSolicitud, rechazarOferta } from './despacho.js';
import { EmisorRegistro } from './eventos.js';
import { crearZona, guardarReferencia } from './gazetteer.js';
import { ocupacionDe, rutaDe } from './ocupacion.js';
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
let expiracionPrevia: string;

before(async () => {
  pool = crearPool();
  const previo = await pool.query(
    `SELECT valor FROM parametro WHERE clave = 'expiracion_solicitud_seg'`,
  );
  expiracionPrevia = previo.rows[0].valor;
  await pool.query(`UPDATE parametro SET valor = '90' WHERE clave = 'expiracion_solicitud_seg'`);
});

after(async () => {
  await pool.query(
    `UPDATE parametro SET valor = $1 WHERE clave = 'expiracion_solicitud_seg'`,
    [expiracionPrevia],
  );
  await pool.end();
});

interface Escenario {
  zonaId: number;
  origenId: number;
  destinoId: number;
  // Segundo destino, en la MISMA zona: sirve para la preferencia direccional.
  destinoVecinoId: number;
  // Destino en otra zona sin relación.
  destinoLejanoId: number;
}

async function montarEscenario(): Promise<Escenario> {
  return enTransaccion(pool, async (c) => {
    const zonaId = (await crearZona(c, `Zona Comp ${randomUUID()}`, 3.75, 8.78)).zonaId;
    const zonaLejana = (await crearZona(c, `Zona Lejos ${randomUUID()}`, 3.80, 8.85)).zonaId;
    return {
      zonaId,
      origenId: (await guardarReferencia(c, {
        zonaId, nombre: 'Origen Comp', lat: 3.75, lng: 8.78,
      })).referenciaId,
      destinoId: (await guardarReferencia(c, {
        zonaId, nombre: 'Destino Comp', lat: 3.751, lng: 8.781,
      })).referenciaId,
      destinoVecinoId: (await guardarReferencia(c, {
        zonaId, nombre: 'Destino Vecino', lat: 3.752, lng: 8.782,
      })).referenciaId,
      destinoLejanoId: (await guardarReferencia(c, {
        zonaId: zonaLejana, nombre: 'Destino Lejano', lat: 3.80, lng: 8.85,
      })).referenciaId,
    };
  });
}

async function crearConductor(zonaId: number, plazas = 4): Promise<number> {
  return enTransaccion(pool, async (c) => {
    const conductor = await c.query(
      `INSERT INTO conductor (telefono, nombre, estado_verificacion, suscrito_hasta)
       VALUES ($1, 'Conductor Compartido', 'verificado', now() + interval '1 day') RETURNING id`,
      [telefonoUnico()],
    );
    const conductorId: number = conductor.rows[0].id;
    await c.query(
      'INSERT INTO vehiculo (conductor_id, matricula, plazas) VALUES ($1, $2, $3)',
      [conductorId, `GE-${Date.now()}${Math.floor(Math.random() * 100000)}-S`, plazas],
    );
    await c.query('INSERT INTO monedero (conductor_id) VALUES ($1)', [conductorId]);
    await c.query(
      `INSERT INTO presencia (conductor_id, zona_id, estado, ultimo_heartbeat)
       VALUES ($1, $2, 'DISPONIBLE', now())`,
      [conductorId, zonaId],
    );
    return conductorId;
  });
}

async function pedir(escenario: Escenario, destinoId?: number): Promise<number> {
  const dispositivo = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES (gen_random_uuid(), 'cliente') RETURNING id`,
  );
  const creada = await enTransaccion(pool, (c) => crearSolicitud(c, {
    dispositivoClienteId: dispositivo.rows[0].id,
    telefonoCliente: '+240222777666',
    referenciaOrigenId: escenario.origenId,
    referenciaDestinoId: destinoId ?? escenario.destinoId,
    actor: 'cliente',
    claveIdempotencia: `comp-${randomUUID()}`,
  }));
  return creada.solicitudId;
}

async function estadoConductor(conductorId: number): Promise<string> {
  const res = await pool.query('SELECT estado FROM presencia WHERE conductor_id = $1', [conductorId]);
  return res.rows[0].estado;
}

async function estadoSolicitud(solicitudId: number): Promise<string> {
  const res = await pool.query('SELECT estado FROM solicitud WHERE id = $1', [solicitudId]);
  return res.rows[0].estado;
}

// Lleva un pasajero hasta RECOGIDO con este conductor.
async function subirPasajero(
  escenario: Escenario,
  conductorId: number,
  destinoId?: number,
): Promise<number> {
  const emisor = new EmisorRegistro();
  const solicitudId = await pedir(escenario, destinoId);
  await iniciarDespacho(pool, emisor, solicitudId);
  const reclamacion = await reclamarSolicitud(pool, emisor, solicitudId, conductorId);
  assert.equal(reclamacion.gano, true, `el conductor debía poder aceptar la solicitud ${solicitudId}`);
  await enTransaccion(pool, (c) => transicionarSolicitud(c, solicitudId, 'EN_CAMINO', 'conductor'));
  await enTransaccion(pool, (c) => transicionarSolicitud(c, solicitudId, 'RECOGIDO', 'conductor'));
  return solicitudId;
}

test('el conductor con plazas libres sigue DISPONIBLE y recibe más ofertas', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductor(escenario.zonaId, 4);

  await subirPasajero(escenario, conductorId);
  assert.equal(await estadoConductor(conductorId), 'DISPONIBLE', 'con 3 plazas libres sigue disponible');

  await subirPasajero(escenario, conductorId);
  const ocupacion = await ocupacionDe(pool, conductorId);
  assert.equal(ocupacion.aBordo, 2);
  assert.equal(ocupacion.libres, 2);
  assert.equal(await estadoConductor(conductorId), 'DISPONIBLE');
});

test('al llenarse el coche pasa a OCUPADO y deja de recibir ofertas', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductor(escenario.zonaId, 2);
  const emisor = new EmisorRegistro();

  await subirPasajero(escenario, conductorId);
  await subirPasajero(escenario, conductorId);
  assert.equal(await estadoConductor(conductorId), 'OCUPADO', 'con 2 de 2 plazas el coche está lleno');

  // Una solicitud nueva no le llega: es el único conductor de la zona, así que
  // se corta con SIN_OFERTA (R1).
  const nueva = await pedir(escenario);
  const resultado = await iniciarDespacho(pool, emisor, nueva);
  assert.equal(resultado.resultado, 'SIN_OFERTA');
});

test('al bajarse un pasajero se libera la plaza y vuelve a recibir ofertas', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductor(escenario.zonaId, 1);
  const emisor = new EmisorRegistro();

  const primero = await subirPasajero(escenario, conductorId);
  assert.equal(await estadoConductor(conductorId), 'OCUPADO');

  await enTransaccion(pool, (c) => transicionarSolicitud(c, primero, 'COMPLETADO', 'conductor'));
  await enTransaccion(pool, async (c) => {
    const { estadoPorOcupacion } = await import('./ocupacion.js');
    const objetivo = await estadoPorOcupacion(c, conductorId);
    assert.equal(objetivo, 'DISPONIBLE', 'liberada la plaza, le toca DISPONIBLE');
  });

  // El cierre real lo hace la API; aquí se comprueba que el despacho ya lo ve
  // libre en cuanto la presencia se ajusta.
  await pool.query(
    `UPDATE presencia SET estado = 'DISPONIBLE' WHERE conductor_id = $1`,
    [conductorId],
  );
  const nueva = await pedir(escenario);
  const resultado = await iniciarDespacho(pool, emisor, nueva);
  assert.equal(resultado.resultado, 'EMITIDO');
  assert.equal(resultado.ofertas, 1);
});

test('preferencia direccional: gana el taxi que ya va hacia esa zona', async () => {
  const escenario = await montarEscenario();
  // Dos conductores idénticos; uno ya lleva un pasajero al destino pedido.
  const enCamino = await crearConductor(escenario.zonaId, 4);
  const vacio = await crearConductor(escenario.zonaId, 4);
  await subirPasajero(escenario, enCamino, escenario.destinoId);

  // Un tercero pide algo al mismo destino: la oleada 1 son 3 conductores, así
  // que ambos reciben oferta, pero el que va hacia allí debe ser el primero.
  const emisor = new EmisorRegistro();
  const nueva = await pedir(escenario, escenario.destinoVecinoId);
  await iniciarDespacho(pool, emisor, nueva, new Date());

  const ofertas = await pool.query(
    'SELECT conductor_id FROM oferta WHERE solicitud_id = $1 ORDER BY id',
    [nueva],
  );
  assert.equal(ofertas.rows[0].conductor_id, enCamino,
    'el primero ofertado debe ser el que ya va en esa dirección');
  assert.ok(ofertas.rows.some((f) => f.conductor_id === vacio),
    'el vacío también recibe oferta, solo va después');
});

test('la ruta del coche lista los destinos de los pasajeros, sin datos personales', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductor(escenario.zonaId, 4);
  await subirPasajero(escenario, conductorId, escenario.destinoId);
  await subirPasajero(escenario, conductorId, escenario.destinoVecinoId);

  const ruta = await rutaDe(pool, conductorId);
  assert.deepEqual(ruta.map((p) => p.destino), ['Destino Comp', 'Destino Vecino']);
  assert.ok(ruta.every((p) => p.estado === 'RECOGIDO'));
  // Solo el lugar (nombre y coordenadas para pintarlo en el plano), su estado y
  // el identificador de la solicitud: nada del pasajero. Esta lista es cerrada
  // a propósito — si alguien añade un campo aquí, esta prueba tiene que
  // fallar y obligar a pensar si revela algo de alguien.
  assert.deepEqual(
    Object.keys(ruta[0]).sort(),
    ['destino', 'estado', 'lat', 'lng', 'solicitudId'],
  );
});

test('GPS con varios pasajeros: si dos están cerca del coche no se marca a ninguno', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductor(escenario.zonaId, 4);
  const emisor = new EmisorRegistro();
  const t0 = new Date();

  // Dos pasajeros aceptados y en camino, ambos sin recoger.
  const ids: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const solicitudId = await pedir(escenario);
    await iniciarDespacho(pool, emisor, solicitudId, t0);
    await reclamarSolicitud(pool, emisor, solicitudId, conductorId, t0);
    await enTransaccion(pool, (c) => transicionarSolicitud(c, solicitudId, 'EN_CAMINO', 'conductor'));
    ids.push(solicitudId);
  }
  const viajes = await pool.query(
    'SELECT id, solicitud_id FROM viaje WHERE solicitud_id = ANY($1)',
    [ids],
  );

  // El coche y los DOS pasajeros, todos a menos de 75 m: señal ambigua.
  for (const viaje of viajes.rows) {
    await enTransaccion(pool, (c) =>
      registrarPosicion(c, viaje.id, 'conductor', 3.7500, 8.7800, t0));
    await enTransaccion(pool, (c) =>
      registrarPosicion(c, viaje.id, 'cliente', 3.75005, 8.78005, t0));
  }
  await procesarProximidad(pool, emisor, t0);

  for (const solicitudId of ids) {
    assert.equal(await estadoSolicitud(solicitudId), 'EN_CAMINO',
      'con ambigüedad no se marca ninguna recogida automática');
  }
});

test('GPS: cada pasajero se cierra por su cuenta al bajarse, sin tocar a los demás', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductor(escenario.zonaId, 4);
  const emisor = new EmisorRegistro();
  const t0 = new Date();

  const primero = await subirPasajero(escenario, conductorId, escenario.destinoId);
  const segundo = await subirPasajero(escenario, conductorId, escenario.destinoVecinoId);
  const viajes = await pool.query(
    'SELECT id, solicitud_id FROM viaje WHERE solicitud_id = ANY($1)',
    [[primero, segundo]],
  );

  // El coche circula: la posición del conductor se registra en AMBOS viajes,
  // como hace el heartbeat de la app.
  for (const viaje of viajes.rows) {
    await enTransaccion(pool, (c) =>
      registrarPosicion(c, viaje.id, 'conductor', 3.7600, 8.7900, t0));
  }
  // El primero se baja (lejos del coche); el segundo sigue dentro.
  // solicitud_id llega como cadena (bigint de PostgreSQL): comparar por texto.
  const viajePrimero = viajes.rows.find((v) => String(v.solicitud_id) === String(primero))!;
  const viajeSegundo = viajes.rows.find((v) => String(v.solicitud_id) === String(segundo))!;
  await enTransaccion(pool, (c) =>
    registrarPosicion(c, viajePrimero.id, 'cliente', 3.7650, 8.7900, t0));
  await enTransaccion(pool, (c) =>
    registrarPosicion(c, viajeSegundo.id, 'cliente', 3.76005, 8.79005, t0));

  await procesarProximidad(pool, emisor, t0);
  assert.equal(await estadoSolicitud(primero), 'COMPLETADO', 'el que se bajó se cierra solo');
  assert.equal(await estadoSolicitud(segundo), 'RECOGIDO', 'el que sigue dentro no se toca');
});

test('liberar a un conductor que ya está DISPONIBLE no da error: rechazo tardío', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductor(escenario.zonaId, 4);
  const emisor = new EmisorRegistro();

  // Con taxi compartido, aceptar deja al conductor DISPONIBLE (le quedan
  // plazas). Si después llega el rechazo de una oferta que ya no existe, el
  // sistema intentaba DISPONIBLE → DISPONIBLE y el taxista veía en pantalla
  // «Transición inválida en ámbito conductor».
  const solicitudId = await pedir(escenario);
  await iniciarDespacho(pool, emisor, solicitudId);
  await reclamarSolicitud(pool, emisor, solicitudId, conductorId);
  assert.equal(await estadoConductor(conductorId), 'DISPONIBLE');

  // Segunda oferta, que se rechaza estando ya DISPONIBLE.
  const otra = await pedir(escenario);
  await iniciarDespacho(pool, emisor, otra);
  await pool.query(
    `UPDATE presencia SET estado = 'DISPONIBLE' WHERE conductor_id = $1`,
    [conductorId],
  );
  await rechazarOferta(pool, otra, conductorId);
  assert.equal(await estadoConductor(conductorId), 'DISPONIBLE',
    'sigue disponible y sin errores');

  const oferta = await pool.query(
    'SELECT resultado FROM oferta WHERE solicitud_id = $1 AND conductor_id = $2',
    [otra, conductorId],
  );
  assert.equal(oferta.rows[0].resultado, 'rechazada', 'el rechazo se registró igualmente');
});

test('perder una reclamación estando ya DISPONIBLE tampoco da error', async () => {
  const escenario = await montarEscenario();
  const ganador = await crearConductor(escenario.zonaId, 4);
  const perdedor = await crearConductor(escenario.zonaId, 4);
  const emisor = new EmisorRegistro();

  // El perdedor ya lleva un pasajero, así que está DISPONIBLE con plazas.
  await subirPasajero(escenario, perdedor);
  assert.equal(await estadoConductor(perdedor), 'DISPONIBLE');

  const solicitudId = await pedir(escenario);
  await iniciarDespacho(pool, emisor, solicitudId);
  await pool.query(
    `UPDATE presencia SET estado = 'DISPONIBLE' WHERE conductor_id = ANY($1)`,
    [[ganador, perdedor]],
  );
  const resultado = await reclamarSolicitud(pool, emisor, solicitudId, ganador);
  assert.equal(resultado.gano, true);
  assert.equal(await estadoConductor(perdedor), 'DISPONIBLE');
});

test('GPS con un solo pasajero pendiente: la recogida automática sí funciona', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductor(escenario.zonaId, 4);
  const emisor = new EmisorRegistro();
  const t0 = new Date();

  // Uno ya a bordo (RECOGIDO, no compite) y otro pendiente.
  await subirPasajero(escenario, conductorId);
  const pendiente = await pedir(escenario);
  await iniciarDespacho(pool, emisor, pendiente, t0);
  await reclamarSolicitud(pool, emisor, pendiente, conductorId, t0);
  await enTransaccion(pool, (c) => transicionarSolicitud(c, pendiente, 'EN_CAMINO', 'conductor'));

  const viaje = await pool.query('SELECT id FROM viaje WHERE solicitud_id = $1', [pendiente]);
  await enTransaccion(pool, (c) =>
    registrarPosicion(c, viaje.rows[0].id, 'conductor', 3.7500, 8.7800, t0));
  await enTransaccion(pool, (c) =>
    registrarPosicion(c, viaje.rows[0].id, 'cliente', 3.75025, 8.78015, t0));

  await procesarProximidad(pool, emisor, t0);
  assert.equal(await estadoSolicitud(pendiente), 'RECOGIDO');
});
