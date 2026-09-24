// Batería de aceptación del paso 5. Requiere la base de datos de desarrollo
// arrancada (npm run bd:dev), migrada y con la semilla cargada.
//
// El reloj se inyecta en todas las funciones del despacho: aquí se simula el
// paso del tiempo (t+20 s, t+45 s, t+90 s) sin esperar de verdad.
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import {
  avanzarDespachos, iniciarDespacho, reclamarSolicitud, rechazarOferta,
} from './despacho.js';
import { ErrorOfertaInvalida } from './errores.js';
import { EmisorRegistro } from './eventos.js';
import { caducarPresencias, registrarHeartbeat } from './presencia.js';
import { crearZona, declararAdyacencia, guardarReferencia } from './gazetteer.js';
import { recargar } from './monedero.js';
import { crearSolicitud } from './transiciones.js';
import { sinAvisoALaCiudad, sinTaxisDeTodaLaIsla } from './ayuda-pruebas.js';


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
let dispositivoClienteId: number;
let expiracionPrevia: string;

before(async () => {
  pool = crearPool();
  const dispositivo = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES (gen_random_uuid(), 'cliente') RETURNING id`,
  );
  dispositivoClienteId = dispositivo.rows[0].id;

  // Estas pruebas dependen de la expiración de 90 s. El valor de la base de
  // desarrollo puede estar cambiado (es un parámetro en caliente), así que se
  // fija aquí y se restaura al terminar: la batería no depende de cómo esté
  // configurada la base ni la deja tocada.
  const previo = await pool.query(
    `SELECT valor FROM parametro WHERE clave = 'expiracion_solicitud_seg'`,
  );
  expiracionPrevia = previo.rows[0].valor;
  await pool.query(
    `UPDATE parametro SET valor = '90' WHERE clave = 'expiracion_solicitud_seg'`,
  );
});

after(async () => {
  await pool.query(
    `UPDATE parametro SET valor = $1 WHERE clave = 'expiracion_solicitud_seg'`,
    [expiracionPrevia],
  );
  await pool.end();
});

// --- Fixtures -------------------------------------------------------------

interface Escenario {
  zonaA: number; // zona del origen
  zonaB: number; // adyacente a A
  refOrigen: number;
  refDestino: number;
}

// Zonas propias por prueba: aíslan de la semilla y de otras pruebas.
async function montarEscenario(): Promise<Escenario> {
  // Migración 048: un taxista de «toda la isla» que quede suelto en la base de
  // desarrollo entra en la oleada 4 de CUALQUIER solicitud, incluidas las de
  // las pruebas que cuentan ofertas exactas — y rompió una de ellas. Se le
  // quita la marca, que no toca la máquina de estados: cambiarle la presencia
  // a mano sí lo hacía, y dejaba conductores en estados que el dominio luego
  // no sabía abandonar.
  await pool.query(
    `UPDATE conductor SET recibe_en_cualquier_zona = false
     WHERE recibe_en_cualquier_zona AND nombre = 'Conductor Despacho'`,
  );
  return enTransaccion(pool, async (c) => {
    const zonaA = (await crearZona(c, `Zona A ${randomUUID()}`, 3.75, 8.78)).zonaId;
    const zonaB = (await crearZona(c, `Zona B ${randomUUID()}`, 3.76, 8.79)).zonaId;
    await declararAdyacencia(c, zonaA, zonaB);
    const refOrigen = (await guardarReferencia(c, {
      zonaId: zonaA, nombre: 'Origen Despacho', lat: 3.75, lng: 8.78,
    })).referenciaId;
    const refDestino = (await guardarReferencia(c, {
      zonaId: zonaA, nombre: 'Destino Despacho', lat: 3.751, lng: 8.781,
    })).referenciaId;
    return { zonaA, zonaB, refOrigen, refDestino };
  });
}

interface OpcionesConductor {
  saldoXaf?: number;
  prioridad?: number;
  desfaseHeartbeatSeg?: number;
  // Por defecto los conductores de prueba están suscritos (migración 011).
  sinSuscripcion?: boolean;
  // Plazas del vehículo (migración 013). Todo conductor despachable tiene
  // vehículo: sin matrícula no se le ofrece nada.
  plazas?: number;
}

async function crearConductorEnZona(zonaId: number, opciones: OpcionesConductor = {}): Promise<number> {
  const saldo = opciones.saldoXaf ?? 1000;
  return enTransaccion(pool, async (c) => {
    const conductor = await c.query(
      `INSERT INTO conductor (telefono, nombre, estado_verificacion, prioridad_despacho, suscrito_hasta)
       VALUES ($1, 'Conductor Despacho', 'verificado', $2,
               CASE WHEN $3 THEN NULL ELSE now() + interval '1 day' END)
       RETURNING id`,
      [
        telefonoUnico(),
        opciones.prioridad ?? 0,
        opciones.sinSuscripcion === true,
      ],
    );
    const conductorId: number = conductor.rows[0].id;
    await c.query(
      `INSERT INTO vehiculo (conductor_id, matricula, marca, color, plazas)
       VALUES ($1, $2, 'Toyota Corolla', 'blanco', $3)`,
      [
        conductorId,
        `GE-${Date.now()}${Math.floor(Math.random() * 100000)}-P`,
        opciones.plazas ?? 4,
      ],
    );
    await c.query('INSERT INTO monedero (conductor_id) VALUES ($1)', [conductorId]);
    if (saldo > 0) {
      await recargar(c, conductorId, saldo, `recarga-despacho-${randomUUID()}`);
    }
    await c.query(
      `INSERT INTO presencia (conductor_id, zona_id, estado, ultimo_heartbeat)
       VALUES ($1, $2, 'DISPONIBLE', now() - make_interval(secs => $3))`,
      [conductorId, zonaId, opciones.desfaseHeartbeatSeg ?? 0],
    );
    return conductorId;
  });
}

async function crearSolicitudEn(escenario: Escenario): Promise<number> {
  const creada = await enTransaccion(pool, (c) => crearSolicitud(c, {
    dispositivoClienteId,
    telefonoCliente: '+240222999994',
    referenciaOrigenId: escenario.refOrigen,
    referenciaDestinoId: escenario.refDestino,
    actor: 'cliente',
    claveIdempotencia: `despacho-${randomUUID()}`,
  }));
  return creada.solicitudId;
}

async function estadoDe(solicitudId: number): Promise<string> {
  const res = await pool.query('SELECT estado FROM solicitud WHERE id = $1', [solicitudId]);
  return res.rows[0].estado;
}

async function estadoConductor(conductorId: number): Promise<string> {
  const res = await pool.query('SELECT estado FROM presencia WHERE conductor_id = $1', [conductorId]);
  return res.rows[0].estado;
}

async function ofertasDe(solicitudId: number): Promise<Array<{ conductorId: number; oleada: number; resultado: string | null }>> {
  const res = await pool.query(
    'SELECT conductor_id, oleada, resultado FROM oferta WHERE solicitud_id = $1 ORDER BY id',
    [solicitudId],
  );
  return res.rows.map((f) => ({ conductorId: f.conductor_id, oleada: f.oleada, resultado: f.resultado }));
}

function despues(base: Date, segundos: number): Date {
  return new Date(base.getTime() + segundos * 1000);
}

// --- Pruebas --------------------------------------------------------------

test('ACEPTACIÓN: dos aceptaciones simultáneas — exactamente una gana y la otra recibe aviso inmediato', async () => {
  const escenario = await montarEscenario();
  const c1 = await crearConductorEnZona(escenario.zonaA);
  const c2 = await crearConductorEnZona(escenario.zonaA);
  const c3 = await crearConductorEnZona(escenario.zonaA);
  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();

  const inicio = await iniciarDespacho(pool, emisor, solicitudId);
  assert.equal(inicio.resultado, 'EMITIDO');
  assert.equal(inicio.ofertas, 3);
  assert.equal(emisor.deTipo('D1_broadcast_solicitud').length, 3);
  // El broadcast lleva destino y banda, jamás el teléfono del cliente (R2/R3).
  const d1 = emisor.deTipo('D1_broadcast_solicitud')[0];
  assert.equal(d1.datos.destino, 'Destino Despacho');
  assert.ok(!JSON.stringify(d1.datos).includes('+240222999994'));

  const [r1, r2] = await Promise.all([
    reclamarSolicitud(pool, emisor, solicitudId, c1),
    reclamarSolicitud(pool, emisor, solicitudId, c2),
  ]);
  const resultados = [r1, r2];
  assert.equal(resultados.filter((r) => r.gano).length, 1, 'exactamente una reclamación gana');
  assert.equal(resultados.filter((r) => !r.gano && r.motivo === 'reclamacion_perdida').length, 1);

  const ganador = r1.gano ? c1 : c2;
  const perdedor = r1.gano ? c2 : c1;
  assert.equal(await estadoDe(solicitudId), 'ACEPTADO');
  // Taxi compartido: el ganador tiene 4 plazas, así que con un pasajero sigue
  // DISPONIBLE. Solo pasaría a OCUPADO al llenarse.
  assert.equal(await estadoConductor(ganador), 'DISPONIBLE');
  assert.equal(await estadoConductor(perdedor), 'DISPONIBLE');
  assert.equal(await estadoConductor(c3), 'DISPONIBLE');

  // Avisos D2 emitidos en la transacción del ganador: 1 ganada + 2 perdidas.
  const d2 = emisor.deTipo('D2_reclamacion_resuelta');
  assert.equal(d2.filter((e) => e.datos.resultado === 'ganada' && e.conductorId === ganador).length, 1);
  assert.deepEqual(
    d2.filter((e) => e.datos.resultado === 'perdida').map((e) => e.conductorId).sort(),
    [perdedor, c3].sort(),
  );

  // El cliente recibe C2 con matrícula y PIN de 4 dígitos (R4/R5).
  const c2Evento = emisor.deTipo('C2_conductor_asignado');
  assert.equal(c2Evento.length, 1);
  assert.match(String(c2Evento[0].datos.pin), /^[0-9]{4}$/);
  assert.match(String(c2Evento[0].datos.matricula), /^GE-/);

  const viaje = await pool.query('SELECT pin FROM viaje WHERE solicitud_id = $1', [solicitudId]);
  assert.equal(viaje.rows[0].pin, c2Evento[0].datos.pin);
});

test('R1: zona sin nadie conectado (ni adyacentes) → SIN_OFERTA inmediato', async () => {
  // Y con el aviso a la ciudad apagado (migración 064): encendido, el corte
  // mira toda la ciudad y basta un taxi de otra prueba para que no corte —que
  // es lo correcto, y tiene sus propias pruebas—. Aquí se mide el corte por
  // zona vacía, que es otra cosa.
  await sinTaxisDeTodaLaIsla(pool, () => sinAvisoALaCiudad(pool, async () => {
  const escenario = await montarEscenario(); // sin conductores en A ni B
  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();

  const resultado = await iniciarDespacho(pool, emisor, solicitudId);
  assert.equal(resultado.resultado, 'SIN_OFERTA');
  assert.equal(await estadoDe(solicitudId), 'SIN_OFERTA');
  const c3 = emisor.deTipo('C3_sin_conductor');
  assert.equal(c3.length, 1);
  assert.equal(c3[0].datos.motivo, 'zona_vacia');
  // Nunca pasó por EMITIDO: no hubo oleada que emitir.
  const transiciones = await pool.query(
    `SELECT count(*)::int AS n FROM transicion WHERE solicitud_id = $1 AND estado_nuevo = 'EMITIDO'`,
    [solicitudId],
  );
  assert.equal(transiciones.rows[0].n, 0);
  }));
});

test('oleadas: 3 más prioritarios → hasta 8 en zona → adyacentes → SIN_OFERTA a los 90 s', async () => {
  // Sin esto, una petición suelta de otra prueba llega a su oleada 5 mientras
  // esta corre y se lleva a TODOS los taxis de la ciudad —los de aquí
  // incluidos— a OFERTADO, y las cuentas de esta prueba dejan de cuadrar.
  await cerrarSolicitudesSueltas();
  const escenario = await montarEscenario();
  const enZonaA: number[] = [];
  for (let prioridad = 0; prioridad < 10; prioridad += 1) {
    enZonaA.push(await crearConductorEnZona(escenario.zonaA, { prioridad }));
  }
  const enZonaB = [
    await crearConductorEnZona(escenario.zonaB),
    await crearConductorEnZona(escenario.zonaB),
  ];
  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();
  const t0 = new Date();

  // Oleada 1: los 3 de mayor prioridad de la zona del origen.
  await iniciarDespacho(pool, emisor, solicitudId, t0);
  let ofertas = await ofertasDe(solicitudId);
  assert.equal(ofertas.length, 3);
  assert.deepEqual(
    ofertas.map((o) => o.conductorId).sort(),
    enZonaA.slice(7).sort(), // prioridades 9, 8 y 7
  );

  // t+10: nada nuevo (la oleada 2 es a los 20 s).
  await avanzarDespachos(pool, emisor, despues(t0, 10));
  assert.equal((await ofertasDe(solicitudId)).length, 3);

  // t+20: oleada 2, hasta 8 en la zona del origen.
  await avanzarDespachos(pool, emisor, despues(t0, 21));
  ofertas = await ofertasDe(solicitudId);
  assert.equal(ofertas.length, 8);
  assert.ok(ofertas.every((o) => enZonaA.includes(o.conductorId)));

  // t+45: oleada 3, zonas adyacentes.
  await avanzarDespachos(pool, emisor, despues(t0, 46));
  ofertas = await ofertasDe(solicitudId);
  assert.equal(ofertas.length, 10);
  assert.deepEqual(
    ofertas.filter((o) => o.oleada === 3).map((o) => o.conductorId).sort(),
    enZonaB.sort(),
  );

  // t+90: expiración. Ofertas expiradas, conductores liberados, C3 al cliente.
  await avanzarDespachos(pool, emisor, despues(t0, 91));
  assert.equal(await estadoDe(solicitudId), 'SIN_OFERTA');
  ofertas = await ofertasDe(solicitudId);
  assert.ok(ofertas.every((o) => o.resultado === 'expirada'));
  for (const conductorId of [...enZonaA.slice(2), ...enZonaB]) {
    assert.equal(await estadoConductor(conductorId), 'DISPONIBLE');
  }
  // avanzarDespachos es global y puede expirar solicitudes residuales de
  // otras ejecuciones: se cuenta solo el C3 de esta solicitud.
  assert.equal(
    emisor.deTipo('C3_sin_conductor').filter((e) => e.solicitudId === solicitudId).length,
    1,
  );
});

test('zona del origen vacía pero adyacente con conductores: se emite y la oleada 3 los alcanza', async () => {
  const escenario = await montarEscenario();
  const enZonaB = await crearConductorEnZona(escenario.zonaB);
  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();
  const t0 = new Date();

  const inicio = await iniciarDespacho(pool, emisor, solicitudId, t0);
  assert.equal(inicio.resultado, 'EMITIDO'); // hay alguien vivo en adyacentes: no se corta
  assert.equal(inicio.ofertas, 0);

  await avanzarDespachos(pool, emisor, despues(t0, 46));
  const ofertas = await ofertasDe(solicitudId);
  assert.deepEqual(ofertas.map((o) => [o.conductorId, o.oleada]), [[enZonaB, 3]]);
});

test('heartbeat: el conductor con heartbeat vencido no recibe ofertas; tras refrescar, sí', async () => {
  // También mira el corte R1, así que necesita que no haya ningún taxista de
  // «toda la isla» en servicio: ver `sinTaxisDeTodaLaIsla`.
  await sinTaxisDeTodaLaIsla(pool, () => sinAvisoALaCiudad(pool, async () => {
  const escenario = await montarEscenario();
  const dormido = await crearConductorEnZona(escenario.zonaA, { desfaseHeartbeatSeg: 130 });
  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();
  const t0 = new Date();

  // Vencido: para R1 no cuenta como vivo → SIN_OFERTA inmediato.
  const inicio = await iniciarDespacho(pool, emisor, solicitudId, t0);
  assert.equal(inicio.resultado, 'SIN_OFERTA');

  // Refresca el heartbeat y pide de nuevo: ahora sí.
  await enTransaccion(pool, (c) => registrarHeartbeat(c, dormido, escenario.zonaA));
  const solicitud2 = await crearSolicitudEn(escenario);
  const inicio2 = await iniciarDespacho(pool, emisor, solicitud2, new Date());
  assert.equal(inicio2.resultado, 'EMITIDO');
  assert.equal(inicio2.ofertas, 1);
  }));
});

test('el conductor sin suscripción vigente no recibe broadcasts (migración 011)', async () => {
  const escenario = await montarEscenario();
  await crearConductorEnZona(escenario.zonaA, { sinSuscripcion: true });
  const suscrito = await crearConductorEnZona(escenario.zonaA);
  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();

  const inicio = await iniciarDespacho(pool, emisor, solicitudId);
  assert.equal(inicio.resultado, 'EMITIDO');
  const ofertas = await ofertasDe(solicitudId);
  assert.deepEqual(ofertas.map((o) => o.conductorId), [suscrito]);
});

test('un conductor OFERTADO no recibe otra oferta hasta responder; al rechazar queda libre', async () => {
  const escenario = await montarEscenario();
  const unico = await crearConductorEnZona(escenario.zonaA);
  const solicitud1 = await crearSolicitudEn(escenario);
  const solicitud2 = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();
  const t0 = new Date();

  await iniciarDespacho(pool, emisor, solicitud1, t0);
  assert.equal(await estadoConductor(unico), 'OFERTADO');

  // La segunda solicitud no le llega (está OFERTADO), pero tampoco se corta:
  // sigue vivo y puede liberarse dentro de la ventana.
  const inicio2 = await iniciarDespacho(pool, emisor, solicitud2, t0);
  assert.equal(inicio2.resultado, 'EMITIDO');
  assert.equal(inicio2.ofertas, 0);

  // Rechaza la primera: libre otra vez; el siguiente tique le ofrece la segunda.
  await rechazarOferta(pool, solicitud1, unico);
  assert.equal(await estadoConductor(unico), 'DISPONIBLE');
  await avanzarDespachos(pool, emisor, despues(t0, 5));
  const ofertas2 = await ofertasDe(solicitud2);
  assert.deepEqual(ofertas2.map((o) => o.conductorId), [unico]);

  // Y no se le vuelve a ofrecer la que rechazó.
  const ofertas1 = await ofertasDe(solicitud1);
  assert.equal(ofertas1.length, 1);
  assert.equal(ofertas1[0].resultado, 'rechazada');
});

test('R2: aceptación fuera de ventana → «expiró hace N segundos»', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductorEnZona(escenario.zonaA);
  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();
  const t0 = new Date();

  await iniciarDespacho(pool, emisor, solicitudId, t0);
  await assert.rejects(
    reclamarSolicitud(pool, emisor, solicitudId, conductorId, despues(t0, 97)),
    (error: unknown) => {
      assert.ok(error instanceof ErrorOfertaInvalida);
      assert.match(error.message, /expiró hace 7 segundos/);
      return true;
    },
  );
  assert.equal(await estadoDe(solicitudId), 'SIN_OFERTA');
  assert.equal(await estadoConductor(conductorId), 'DISPONIBLE');
});

test('reclamar sin tener oferta: rechazo explícito', async () => {
  const escenario = await montarEscenario();
  await crearConductorEnZona(escenario.zonaA);
  const intruso = await crearConductorEnZona(escenario.zonaB);
  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();

  await iniciarDespacho(pool, emisor, solicitudId);
  await assert.rejects(
    reclamarSolicitud(pool, emisor, solicitudId, intruso),
    /no tiene ninguna oferta/,
  );
});

test('el turno NO se cae por un latido viejo: dos minutos de túnel no son salir de servicio', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductorEnZona(escenario.zonaA);
  // Latido de hace media hora: antes esto le sacaba de servicio.
  await enTransaccion(pool, (c) => registrarHeartbeat(
    c, conductorId, escenario.zonaA, new Date(Date.now() - 30 * 60_000),
  ));

  const caducados = await enTransaccion(pool, (c) => caducarPresencias(c));
  assert.equal(await estadoConductor(conductorId), 'DISPONIBLE', 'sigue siendo su turno');
  assert.ok(caducados >= 0);

  // Y sin embargo el reparto no le ofrece nada: el filtro de latido fresco
  // sigue en pie, que es lo que de verdad protege al pasajero.
  const solicitudId = await crearSolicitudEn(escenario);
  await iniciarDespacho(pool, new EmisorRegistro(), solicitudId, new Date());
  const ofertas = await ofertasDe(solicitudId);
  assert.equal(
    ofertas.some((o) => o.conductorId === conductorId), false,
    'a un móvil que no contesta no se le manda una carrera, esté o no en servicio',
  );
});

test('a las doce horas sin dar señales se da el turno por abandonado', async () => {
  const escenario = await montarEscenario();
  const conductorId = await crearConductorEnZona(escenario.zonaA);
  await enTransaccion(pool, (c) => registrarHeartbeat(
    c, conductorId, escenario.zonaA, new Date(Date.now() - 13 * 3600_000),
  ));

  await enTransaccion(pool, (c) => caducarPresencias(c));
  assert.equal(
    await estadoConductor(conductorId), 'DESCONECTADO',
    'ningún turno dura medio día: ese móvil no va a volver',
  );
});

// Migración 031: un barrio/calle (zona con padre) no tiene adyacencia
// propia. Un lugar colgado de uno tiene que repartirse igual que si
// colgara directamente de su distrito urbano — si esto fallara, cualquier
// sitio clasificado con más precisión se quedaría sin taxis.
test('un lugar colgado de un barrio/calle se reparte por su distrito urbano padre', async () => {
  const escenario = await montarEscenario();
  const barrio = await enTransaccion(pool, async (c) => {
    const fila = await c.query(
      `INSERT INTO zona (nombre, zona_padre_id) VALUES ($1, $2) RETURNING id`,
      [`Barrio de prueba ${randomUUID()}`, escenario.zonaA],
    );
    return fila.rows[0].id as number;
  });
  const refOrigenEnBarrio = await enTransaccion(pool, async (c) => {
    const r = await guardarReferencia(c, {
      zonaId: barrio, nombre: 'Sitio en el barrio', lat: 3.7501, lng: 8.7801,
    });
    return r.referenciaId;
  });

  const conductorEnDistrito = await crearConductorEnZona(escenario.zonaA);
  const creada = await enTransaccion(pool, (c) => crearSolicitud(c, {
    dispositivoClienteId,
    telefonoCliente: '+240222999995',
    referenciaOrigenId: refOrigenEnBarrio,
    referenciaDestinoId: escenario.refDestino,
    actor: 'cliente',
    claveIdempotencia: `despacho-barrio-${randomUUID()}`,
  }));
  const solicitudId = creada.solicitudId;
  const emisor = new EmisorRegistro();

  const inicio = await iniciarDespacho(pool, emisor, solicitudId);
  assert.equal(inicio.resultado, 'EMITIDO');
  assert.equal(inicio.ofertas, 1);
  const ofertas = await pool.query('SELECT conductor_id FROM oferta WHERE solicitud_id = $1', [solicitudId]);
  assert.equal(ofertas.rows[0].conductor_id, conductorEnDistrito);
});

// Un taxista de «toda la isla» es global por definición: le alcanza CUALQUIER
// solicitud viva, incluidas las que otras pruebas dejaron a medias en esta
// base compartida (P12-03). Si una de esas se lo lleva primero, queda OFERTADO
// y la solicitud de la prueba ya no puede ofrecérsela. Se cierran antes.
async function cerrarSolicitudesSueltas(): Promise<void> {
  const abiertas = await pool.query(
    `UPDATE solicitud SET estado = 'SIN_OFERTA'
     WHERE estado IN ('SOLICITADO', 'EMITIDO') RETURNING id, estado`,
  );
  for (const fila of abiertas.rows) {
    await pool.query(
      `INSERT INTO transicion (ambito, solicitud_id, estado_anterior, estado_nuevo, actor, origen_evento)
       VALUES ('solicitud', $1, $2, 'SIN_OFERTA', 'sistema', 'aislamiento_prueba')`,
      [fila.id, fila.estado],
    );
  }
  await pool.query(
    `UPDATE oferta SET resultado = 'expirada', respondida_en = now()
     WHERE resultado IS NULL`,
  );
}

// Migración 048: el taxi que recibe de toda la isla.
test('cualquier zona: le llega la carrera, pero DESPUÉS de los que están cerca', async () => {
  await cerrarSolicitudesSueltas();
  const escenario = await montarEscenario();
  // Uno en el barrio del pasajero y otro en una zona que no toca ninguna de
  // las del escenario: es el operador desde su oficina.
  const cercano = await crearConductorEnZona(escenario.zonaA);
  const lejano = await enTransaccion(pool, async (c) => {
    const { zonaId } = await crearZona(c, `Zona LEJOS ${randomUUID()}`, 3.46, 8.55);
    return { zonaId };
  }).then(({ zonaId }) => crearConductorEnZona(zonaId));
  await pool.query(
    'UPDATE conductor SET recibe_en_cualquier_zona = true WHERE id = $1',
    [lejano],
  );

  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();
  const t0 = new Date();

  // Oleada 1: solo el que está en el barrio. El de toda la isla NO entra aquí,
  // que es lo que garantiza que no le quita la carrera a nadie de al lado.
  await iniciarDespacho(pool, emisor, solicitudId, t0);
  let ofertas = await ofertasDe(solicitudId);
  assert.deepEqual(ofertas.map((o) => o.conductorId), [cercano]);

  // t+21, oleada 2: sigue sin entrar. No está en el barrio del pasajero.
  await avanzarDespachos(pool, emisor, despues(t0, 21));
  ofertas = await ofertasDe(solicitudId);
  assert.equal(
    ofertas.some((o) => o.conductorId === lejano), false,
    'mientras les toca a los de cerca, el de toda la isla espera',
  );

  // t+60 en adelante: la oleada 4, cuando los de cerca —y los de los barrios
  // vecinos, a los 45— ya han tenido su turno (migración 060).
  await avanzarDespachos(pool, emisor, despues(t0, 61));
  ofertas = await ofertasDe(solicitudId);
  const suya = ofertas.find((o) => o.conductorId === lejano);
  assert.ok(suya, 'el de toda la isla tiene que acabar recibiéndola');
  assert.equal(suya!.oleada, 4, 'y en la última oleada, no antes');

  // Se le quita la marca al terminar, por la misma razón que en
  // `montarEscenario`: si se queda, aparece en la oleada 4 de todo lo que
  // venga después.
  await pool.query(
    'UPDATE conductor SET recibe_en_cualquier_zona = false WHERE id = $1', [lejano],
  );
});

test('cualquier zona: sin el interruptor, nadie recibe fuera de su barrio', async () => {
  await cerrarSolicitudesSueltas();
  const escenario = await montarEscenario();
  const lejano = await enTransaccion(pool, async (c) => {
    const { zonaId } = await crearZona(c, `Zona LEJOS ${randomUUID()}`, 3.46, 8.55);
    return { zonaId };
  }).then(({ zonaId }) => crearConductorEnZona(zonaId));

  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();
  const t0 = new Date();
  await iniciarDespacho(pool, emisor, solicitudId, t0);
  await avanzarDespachos(pool, emisor, despues(t0, 50));

  const ofertas = await ofertasDe(solicitudId);
  assert.equal(
    ofertas.some((o) => o.conductorId === lejano), false,
    'el reparto por barrio sigue siendo la regla para todos los demás',
  );
});

// --- 21/09: diagnóstico de los taxistas «de toda la isla» ------------------

async function conductorDeTodaLaIsla(): Promise<number> {
  const { zonaId } = await enTransaccion(pool, (c) => crearZona(c, `Zona LEJOS ${randomUUID()}`, 3.46, 8.55));
  const id = await crearConductorEnZona(zonaId);
  await pool.query('UPDATE conductor SET recibe_en_cualquier_zona = true WHERE id = $1', [id]);
  return id;
}

test('cualquier zona: si es el ÚNICO taxi en servicio, la carrera no muere al pedirla', async () => {
  // El caso para el que existe la oleada 4 —«una solicitud que iba a morir sin
  // oferta todavía tiene una posibilidad»— y el único que no estaba probado.
  // El corte R1 de `iniciarDespacho` mira si hay alguien vivo en el barrio o
  // en los vecinos; si no hay nadie, cierra con SIN_OFERTA en el acto. El de
  // toda la isla no está en ninguno de los dos, así que la carrera moría
  // antes de que su oleada llegara a existir.
  await cerrarSolicitudesSueltas();
  const escenario = await montarEscenario();
  const lejano = await conductorDeTodaLaIsla();
  try {
    const solicitudId = await crearSolicitudEn(escenario);
    const emisor = new EmisorRegistro();
    const t0 = new Date();

    const inicio = await iniciarDespacho(pool, emisor, solicitudId, t0);
    assert.equal(inicio.resultado, 'EMITIDO',
      'hay un taxi que puede recibirla: no se puede cortar con «no hay taxi»');

    await avanzarDespachos(pool, emisor, despues(t0, 70));
    const ofertas = await ofertasDe(solicitudId);
    assert.ok(ofertas.some((o) => o.conductorId === lejano && o.oleada === 4),
      'tiene que acabar recibiéndola en la oleada 4');
  } finally {
    await pool.query('UPDATE conductor SET recibe_en_cualquier_zona = false WHERE id = $1', [lejano]);
  }
});

test('cualquier zona: la oleada 4 llega DESPUÉS de la de los barrios vecinos, no a la vez', async () => {
  // La 048 promete que el de toda la isla no le quita nunca la carrera a quien
  // está al lado. Pero la oleada 3 (barrios vecinos) y la 4 salían en el mismo
  // segundo —las dos a los 45—, así que el de la oficina y el del barrio de al
  // lado recibían la oferta a la vez y ganaba quien pulsara primero.
  await cerrarSolicitudesSueltas();
  const escenario = await montarEscenario();
  const vecino = await crearConductorEnZona(escenario.zonaB);
  const lejano = await conductorDeTodaLaIsla();
  try {
    const solicitudId = await crearSolicitudEn(escenario);
    const emisor = new EmisorRegistro();
    const t0 = new Date();
    await iniciarDespacho(pool, emisor, solicitudId, t0);

    // Justo pasada la oleada 3: al vecino sí, al de toda la isla todavía no.
    await avanzarDespachos(pool, emisor, despues(t0, 46));
    let ofertas = await ofertasDe(solicitudId);
    assert.ok(ofertas.some((o) => o.conductorId === vecino), 'el del barrio de al lado, en la oleada 3');
    assert.equal(ofertas.some((o) => o.conductorId === lejano), false,
      'el de toda la isla tiene que esperar a que el vecino haya tenido su turno');

    // Y después, sí.
    await avanzarDespachos(pool, emisor, despues(t0, 75));
    ofertas = await ofertasDe(solicitudId);
    assert.ok(ofertas.some((o) => o.conductorId === lejano && o.oleada === 4));
  } finally {
    await pool.query('UPDATE conductor SET recibe_en_cualquier_zona = false WHERE id = $1', [lejano]);
  }
});

// --- Migración 065: la reputación cuenta en el reparto ---------------------

// Le pone al taxista `cuantas` valoraciones de `nota`, inventando el viaje que
// las justifica. Directo por SQL: lo que se prueba es el ORDEN del reparto, no
// el camino por el que se valora, que tiene sus propias pruebas.
async function valorarAsi(conductorId: number, nota: number, cuantas: number): Promise<void> {
  for (let i = 0; i < cuantas; i += 1) {
    const solicitud = await pool.query(
      `INSERT INTO solicitud
         (dispositivo_cliente_id, telefono_cliente, referencia_origen_id,
          referencia_destino_id, clave_idempotencia, estado, conductor_id)
       SELECT $1, '+240222999995', r.id, r.id, $2, 'COMPLETADO', $3
       FROM referencia r LIMIT 1
       RETURNING id`,
      [dispositivoClienteId, `nota-${randomUUID()}`, conductorId],
    );
    const viaje = await pool.query(
      `INSERT INTO viaje (solicitud_id, conductor_id, pin) VALUES ($1, $2, '1234') RETURNING id`,
      [solicitud.rows[0].id, conductorId],
    );
    await pool.query(
      `INSERT INTO valoracion (viaje_id, emisor, puntuacion) VALUES ($1, 'cliente', $2)`,
      [viaje.rows[0].id, nota],
    );
  }
}

test('con la misma prioridad, la carrera va antes a quien está mejor valorado', async () => {
  const escenario = await montarEscenario();
  const bueno = await crearConductorEnZona(escenario.zonaA);
  const malo = await crearConductorEnZona(escenario.zonaA);
  const nuevo = await crearConductorEnZona(escenario.zonaA);
  const otroNuevo = await crearConductorEnZona(escenario.zonaA);
  await valorarAsi(bueno, 5, 6);
  await valorarAsi(malo, 2, 6);
  // El nuevo se queda con tres valoraciones malas: por debajo del mínimo, no
  // cuentan. Tres pasajeros de mal día no dejan a nadie sin trabajo.
  await valorarAsi(nuevo, 1, 3);

  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();
  await iniciarDespacho(pool, emisor, solicitudId);

  // La oleada 1 son tres: el bien valorado y los dos que no tienen nota que
  // cuente. El de las malas notas espera a la oleada 2.
  const primeros = (await ofertasDe(solicitudId)).map((o) => String(o.conductorId));
  assert.equal(primeros.length, 3);
  assert.ok(primeros.includes(String(bueno)), 'el bien valorado va en la primera oleada');
  assert.equal(primeros.includes(String(malo)), false, 'el mal valorado va detrás');
  assert.ok(
    primeros.includes(String(nuevo)) && primeros.includes(String(otroNuevo)),
    'sin valoraciones suficientes se va en el tramo del medio, no castigado',
  );
});

test('la mala nota retrasa, no excluye: en la oleada siguiente también recibe', async () => {
  const escenario = await montarEscenario();
  const malo = await crearConductorEnZona(escenario.zonaA);
  await valorarAsi(malo, 1, 8);
  for (let i = 0; i < 3; i += 1) await crearConductorEnZona(escenario.zonaA);

  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();
  const t0 = new Date();
  await iniciarDespacho(pool, emisor, solicitudId, t0);
  assert.equal(
    (await ofertasDe(solicitudId)).some((o) => String(o.conductorId) === String(malo)),
    false,
  );

  // Dejar a alguien sin trabajo por una media es una sanción, y las sanciones
  // las pone el operador con un nombre detrás. Aquí solo va después.
  await avanzarDespachos(pool, emisor, despues(t0, 21));
  assert.ok(
    (await ofertasDe(solicitudId)).some((o) => String(o.conductorId) === String(malo)),
    'la oleada 2 sí le llega',
  );
});

// --- Migración 064: la oleada 5, toda la ciudad antes de rendirse ----------

test('sin nadie en el barrio, la carrera ya no muere: se ofrece a toda la ciudad', async () => {
  await cerrarSolicitudesSueltas();
  const escenario = await montarEscenario();
  // Un taxi en una zona SUELTA: ni es el barrio del origen, ni su vecina, ni
  // recibe de toda la isla. Es decir, el reparto normal no lo alcanza nunca.
  const lejos = (await enTransaccion(pool, (c) =>
    crearZona(c, `Zona lejana ${randomUUID()}`, 3.80, 8.85))).zonaId;
  const suelto = await crearConductorEnZona(lejos);

  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();
  const t0 = new Date();

  // Antes de la 064 esto era SIN_OFERTA en el acto: barrio vacío, vecinos
  // vacíos. Ahora la petición vive, porque hay un taxi en la ciudad al que
  // todavía se le puede preguntar.
  const inicio = await iniciarDespacho(pool, emisor, solicitudId, t0);
  assert.equal(inicio.resultado, 'EMITIDO');
  assert.equal(inicio.ofertas, 0, 'y no se le ofrece a nadie todavía: no es su turno');

  // A los 60 s sigue sin tocarle: las oleadas del barrio y de los vecinos
  // tienen que haber pasado primero.
  await avanzarDespachos(pool, emisor, despues(t0, 61));
  assert.equal((await ofertasDe(solicitudId)).length, 0);

  // A los 75, ya no queda nadie a quien esperar. Se comprueba que ESTÉ, no
  // quiénes son todos: la oleada 5 convoca a la ciudad entera, y en la base de
  // desarrollo la ciudad son también los taxis que dejaron otras pruebas
  // (P12-03). Que aparezcan es precisamente lo que se está probando.
  await avanzarDespachos(pool, emisor, despues(t0, 76));
  const ofertas = await ofertasDe(solicitudId);
  assert.ok(ofertas.some((o) => String(o.conductorId) === String(suelto) && o.oleada === 5),
    `el taxi del otro barrio tenía que recibirla: ${JSON.stringify(ofertas)}`);
  assert.equal(ofertas.every((o) => o.oleada === 5), true, 'y ninguna antes de la 5');
});

test('si alguien tiene la oferta en la mano, no se convoca a la ciudad', async () => {
  await cerrarSolicitudesSueltas();
  const escenario = await montarEscenario();
  const delBarrio = await crearConductorEnZona(escenario.zonaA);
  const lejos = (await enTransaccion(pool, (c) =>
    crearZona(c, `Zona lejana ${randomUUID()}`, 3.81, 8.86))).zonaId;
  await crearConductorEnZona(lejos);

  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();
  const t0 = new Date();
  await iniciarDespacho(pool, emisor, solicitudId, t0);

  // El del barrio la tiene delante y no ha contestado. Aunque pasen los 75 s,
  // nadie más se entera: su respuesta puede llegar, y quitarle la carrera al
  // que está al lado del pasajero es justo lo que el reparto por oleadas
  // evita.
  await avanzarDespachos(pool, emisor, despues(t0, 80));
  const ofertas = await ofertasDe(solicitudId);
  assert.deepEqual(ofertas.map((o) => o.conductorId), [delBarrio]);
  assert.equal(ofertas.every((o) => o.oleada < 5), true);
});

test('rechazada por todos, la ciudad entera sí se entera', async () => {
  await cerrarSolicitudesSueltas();
  const escenario = await montarEscenario();
  const delBarrio = await crearConductorEnZona(escenario.zonaA);
  const lejos = (await enTransaccion(pool, (c) =>
    crearZona(c, `Zona lejana ${randomUUID()}`, 3.82, 8.87))).zonaId;
  const suelto = await crearConductorEnZona(lejos);

  const solicitudId = await crearSolicitudEn(escenario);
  const emisor = new EmisorRegistro();
  const t0 = new Date();
  await iniciarDespacho(pool, emisor, solicitudId, t0);
  await rechazarOferta(pool, solicitudId, delBarrio);

  await avanzarDespachos(pool, emisor, despues(t0, 76));
  const ofertas = await ofertasDe(solicitudId);
  assert.ok(ofertas.some((o) => o.conductorId === suelto && o.oleada === 5),
    'ya no hay ninguna oferta viva: es la carrera o nada');
});

test('con el aviso apagado, el reparto es el de antes', async () => {
  await cerrarSolicitudesSueltas();
  await sinTaxisDeTodaLaIsla(pool, () => sinAvisoALaCiudad(pool, async () => {
    const escenario = await montarEscenario();
    const lejos = (await enTransaccion(pool, (c) =>
      crearZona(c, `Zona lejana ${randomUUID()}`, 3.83, 8.88))).zonaId;
    await crearConductorEnZona(lejos);

    const solicitudId = await crearSolicitudEn(escenario);
    const emisor = new EmisorRegistro();
    // El taxi de la otra punta existe, pero el interruptor está a 0: la
    // petición se cierra en el acto, como antes de la 064.
    const inicio = await iniciarDespacho(pool, emisor, solicitudId);
    assert.equal(inicio.resultado, 'SIN_OFERTA');
  }));
});

// --- Migración 062: el pasajero elige coche --------------------------------

async function pedirEligiendo(escenario: Escenario, conductorId: number): Promise<number> {
  const creada = await enTransaccion(pool, (c) => crearSolicitud(c, {
    dispositivoClienteId: dispositivoClienteId,
    telefonoCliente: '+240222999993',
    referenciaOrigenId: escenario.refOrigen,
    referenciaDestinoId: escenario.refDestino,
    actor: 'cliente',
    claveIdempotencia: `elige-${randomUUID()}`,
    conductorElegidoId: conductorId,
  }));
  return creada.solicitudId;
}

test('el coche elegido recibe la carrera en exclusiva, y solo unos segundos', async () => {
  await cerrarSolicitudesSueltas();
  const escenario = await montarEscenario();
  const elegido = await crearConductorEnZona(escenario.zonaA);
  const otro = await crearConductorEnZona(escenario.zonaA);

  const solicitudId = await pedirEligiendo(escenario, elegido);
  const emisor = new EmisorRegistro();
  const t0 = new Date();
  await iniciarDespacho(pool, emisor, solicitudId, t0);

  // Oleada 0: solo él. El otro está en el mismo barrio y no la ve todavía.
  let ofertas = await ofertasDe(solicitudId);
  assert.deepEqual(ofertas.map((o) => o.conductorId), [elegido]);
  assert.equal(ofertas[0].oleada, 0);

  // Mientras dura su exclusiva (20 s), sigue siendo el único.
  await avanzarDespachos(pool, emisor, despues(t0, 10));
  ofertas = await ofertasDe(solicitudId);
  assert.equal(ofertas.length, 1, 'durante la exclusiva no se ofrece a nadie más');

  // Pasada, el reparto normal arranca: el otro la recibe.
  await avanzarDespachos(pool, emisor, despues(t0, 25));
  ofertas = await ofertasDe(solicitudId);
  assert.ok(ofertas.some((o) => o.conductorId === otro),
    'si el elegido no la coge, la carrera sigue su camino');
  // Y el elegido conserva la suya: puede aceptarla hasta que caduque.
  assert.ok(ofertas.some((o) => o.conductorId === elegido && o.oleada === 0));
});

test('elegir un coche que ya no puede no deja la carrera sin reparto', async () => {
  // Entre elegir y pulsar pasan segundos, y en ese rato el taxi puede coger
  // otra carrera o salir de servicio. La elección se cae y el reparto normal
  // empieza en el acto, sin esperar la exclusiva de alguien que no está.
  await cerrarSolicitudesSueltas();
  const escenario = await montarEscenario();
  const elegido = await crearConductorEnZona(escenario.zonaA);
  const otro = await crearConductorEnZona(escenario.zonaA);
  await pool.query(
    `UPDATE presencia SET estado = 'DESCONECTADO' WHERE conductor_id = $1`, [elegido],
  );

  const solicitudId = await pedirEligiendo(escenario, elegido);
  const emisor = new EmisorRegistro();
  const inicio = await iniciarDespacho(pool, emisor, solicitudId, new Date());
  assert.equal(inicio.resultado, 'EMITIDO');

  const ofertas = await ofertasDe(solicitudId);
  assert.deepEqual(ofertas.map((o) => o.conductorId), [otro],
    'la oleada 1 normal, desde el primer segundo');
});
