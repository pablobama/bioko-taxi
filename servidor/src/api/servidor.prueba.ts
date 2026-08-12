// Batería del paso 7 (API HTTP). Requiere la base de datos de desarrollo
// arrancada (npm run bd:dev), migrada y con la semilla cargada.
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { reclamarSolicitud } from '../dominio/despacho.js';
import { EmisorRegistro } from '../dominio/eventos.js';
import { crearZona, guardarReferencia } from '../dominio/gazetteer.js';
import { recargar } from '../dominio/monedero.js';
import { registrarPosicion } from '../dominio/proximidad.js';
import { confirmarRecarga } from '../dominio/recargas.js';
import { reputacionDe } from '../dominio/reputacion.js';
import { transicionarSolicitud } from '../dominio/transiciones.js';
import { ConexionesSse } from '../eventos/adaptador-sse.js';
import { credencialesEfimeras } from './llamadas.js';
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

  zonaId = (await enTransaccion(pool, (c) => crearZona(c, `Zona API ${randomUUID()}`, 3.75, 8.78))).zonaId;
  origenId = (await enTransaccion(pool, (c) => guardarReferencia(c, {
    zonaId, nombre: 'Origen API', lat: 3.75, lng: 8.78,
  }))).referenciaId;
  destinoId = (await enTransaccion(pool, (c) => guardarReferencia(c, {
    zonaId, nombre: 'Destino API', lat: 3.751, lng: 8.781,
  }))).referenciaId;
});

after(async () => {
  await app.close();
  await pool.end();
});

// Sufijo único para matrículas y demás. Los teléfonos van por su propio
// generador (telefonoUnico), que además respeta la forma canónica.
let contadorUnico = 0;
function sufijoUnico(): string {
  contadorUnico += 1;
  const aleatorio = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  return `${aleatorio}${String(contadorUnico).padStart(3, '0')}`;
}

// Zona nueva por conductor. Con taxi compartido los conductores de pruebas
// anteriores ya no quedan OCUPADO al aceptar: si compartieran zona seguirían
// compitiendo por la oleada 1 y el reparto dejaría de ser determinista.
async function crearConductorEnZona(): Promise<number> {
  zonaId = (await enTransaccion(pool, (c) => crearZona(c, `Zona API ${randomUUID()}`, 3.75, 8.78))).zonaId;
  origenId = (await enTransaccion(pool, (c) => guardarReferencia(c, {
    zonaId, nombre: 'Origen API', lat: 3.75, lng: 8.78,
  }))).referenciaId;
  destinoId = (await enTransaccion(pool, (c) => guardarReferencia(c, {
    zonaId, nombre: 'Destino API', lat: 3.751, lng: 8.781,
  }))).referenciaId;

  return enTransaccion(pool, async (c) => {
    const conductor = await c.query(
      `INSERT INTO conductor (telefono, nombre, estado_verificacion, suscrito_hasta)
       VALUES ($1, 'Conductor API', 'verificado', now() + interval '1 day') RETURNING id`,
      [telefonoUnico()],
    );
    const conductorId: number = conductor.rows[0].id;
    await c.query(
      `INSERT INTO vehiculo (conductor_id, matricula) VALUES ($1, $2)`,
      [conductorId, `GE-${Date.now()}${Math.floor(Math.random() * 100000)}-A`],
    );
    await c.query('INSERT INTO monedero (conductor_id) VALUES ($1)', [conductorId]);
    await recargar(c, conductorId, 1000, `recarga-api-${randomUUID()}`);
    await c.query(
      `INSERT INTO presencia (conductor_id, zona_id, estado, ultimo_heartbeat)
       VALUES ($1, $2, 'DISPONIBLE', now())`,
      [conductorId, zonaId],
    );
    return conductorId;
  });
}

function cabeceras(uuid: string): Record<string, string> {
  return { 'x-dispositivo': uuid, 'content-type': 'application/json' };
}

async function pedirTaxi(uuid: string): Promise<{ solicitudId: number; estado: string; yaExistia: boolean }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/solicitudes',
    headers: cabeceras(uuid),
    payload: { telefono: '+240222999992', origenId, destinoId },
  });
  assert.ok(res.statusCode < 300, `pedirTaxi falló: ${res.statusCode} ${res.body}`);
  return res.json();
}

test('API: pedir taxi crea la solicitud, la despacha y es idempotente en la ventana de 60 s', async () => {
  await crearConductorEnZona();
  const uuid = randomUUID();

  const primera = await pedirTaxi(uuid);
  assert.equal(primera.estado, 'EMITIDO');
  assert.equal(primera.yaExistia, false);

  // El doble toque / reintento de red no crea una segunda solicitud (R1).
  const segunda = await pedirTaxi(uuid);
  assert.equal(segunda.yaExistia, true);
  assert.equal(segunda.solicitudId, primera.solicitudId);
});

test('sesión: dice qué es el dispositivo, y el alta del taxista queda verificada sin revisión (P21-01)', async () => {
  const uuid = randomUUID();
  const sinRol = await app.inject({ method: 'GET', url: '/api/sesion', headers: cabeceras(uuid) });
  assert.equal(sinRol.json().rol, null, 'un dispositivo nuevo no tiene rol');

  const telefono = telefonoUnico();
  const alta = await app.inject({
    method: 'POST',
    url: '/api/conductor/alta',
    headers: cabeceras(uuid),
    payload: {
      nombre: 'Juan Mba', telefono, matricula: `GE-J${sufijoUnico()}`,
      marca: 'Toyota Hilux', carroceria: '4x4',
    },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  // Decisión del 2026-07-28, «por ahora» (PENDIENTES.md P21-01): sin revisión
  // manual obligatoria, el alta se acepta verificada de entrada.
  assert.equal(alta.json().estadoVerificacion, 'verificado');
  assert.equal(alta.json().aviso, null);

  const sesion = await app.inject({ method: 'GET', url: '/api/sesion', headers: cabeceras(uuid) });
  const datos = sesion.json();
  assert.equal(datos.rol, 'conductor');
  assert.equal(datos.conductor.verificado, true, 'verificado de entrada: puede trabajar ya');
  assert.equal(datos.conductor.carroceria, '4x4');
  assert.equal(datos.conductor.plazas, 4);
  assert.equal(datos.conductor.reputacion.media, null);
});

test('reenviar el alta también auto-verifica (P21-01): a quien quedó pendiente antes de la decisión no se le olvida', async () => {
  const uuid = randomUUID();
  const telefono = telefonoUnico();
  const alta1 = await app.inject({
    method: 'POST',
    url: '/api/conductor/alta',
    headers: cabeceras(uuid),
    payload: {
      nombre: 'Ana Ondo', telefono, matricula: `GE-A${sufijoUnico()}`,
      marca: 'Kia Rio', carroceria: 'turismo',
    },
  });
  const conductorId = alta1.json().conductorId;

  // Simula una fila de antes de la decisión de auto-verificar: 'pendiente' a
  // mano, saltándose la API.
  await pool.query(`UPDATE conductor SET estado_verificacion = 'pendiente' WHERE id = $1`, [conductorId]);

  const alta2 = await app.inject({
    method: 'POST',
    url: '/api/conductor/alta',
    headers: cabeceras(uuid),
    payload: {
      nombre: 'Ana Ondo', telefono, matricula: `GE-A${sufijoUnico()}`,
      marca: 'Kia Rio', carroceria: 'turismo',
    },
  });
  assert.equal(alta2.statusCode, 200, alta2.body);
  assert.equal(alta2.json().estadoVerificacion, 'verificado', 'reenviar el alta también saca de pendiente');

  // Pero a un conductor que el operador suspendió o bloqueó, reenviar el
  // formulario no le sirve para saltárselo.
  await pool.query(`UPDATE conductor SET estado_verificacion = 'suspendido' WHERE id = $1`, [conductorId]);
  const alta3 = await app.inject({
    method: 'POST',
    url: '/api/conductor/alta',
    headers: cabeceras(uuid),
    payload: {
      nombre: 'Ana Ondo', telefono, matricula: `GE-A${sufijoUnico()}`,
      marca: 'Kia Rio', carroceria: 'turismo',
    },
  });
  assert.equal(alta3.json().estadoVerificacion, 'suspendido', 'un suspendido no se reactiva solo con reenviar');
});

test('alta de taxista: valida los datos y no deja robar una matrícula ajena', async () => {
  const base = sufijoUnico();
  const primero = randomUUID();
  const matricula = `GE-M${base}`;
  await app.inject({
    method: 'POST', url: '/api/conductor/alta', headers: cabeceras(primero),
    payload: {
      nombre: 'Dueña Real', telefono: telefonoUnico(),
      matricula, marca: 'Kia', carroceria: 'turismo',
    },
  });

  const ladron = await app.inject({
    method: 'POST', url: '/api/conductor/alta', headers: cabeceras(randomUUID()),
    payload: {
      nombre: 'Otro', telefono: telefonoUnico(),
      matricula, marca: 'Kia', carroceria: 'turismo',
    },
  });
  assert.equal(ladron.statusCode, 409);
  assert.match(ladron.json().error, /ya está registrada por otro/);

  for (const [carga, patron] of [
    [{ nombre: 'A', telefono: '+240222000111', marca: 'Kia', carroceria: 'turismo' }, /Faltan datos/],
    [{ nombre: 'A', telefono: 'xx', matricula: 'GE-1', marca: 'Kia', carroceria: 'turismo' }, /Teléfono no válido/],
    [{ nombre: 'A', telefono: '+240222000111', matricula: 'GE-1', marca: 'Kia', carroceria: 'furgoneta' }, /Carrocería no válida/],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    const res = await app.inject({
      method: 'POST', url: '/api/conductor/alta', headers: cabeceras(randomUUID()), payload: carga,
    });
    assert.equal(res.statusCode, 400, JSON.stringify(carga));
    assert.match(res.json().error, patron);
  }
});

test('un dispositivo de pasajero no puede darse de alta como taxista', async () => {
  const uuid = randomUUID();
  await app.inject({
    method: 'PUT', url: '/api/perfil', headers: cabeceras(uuid), payload: { telefono: '+240222123123' },
  });
  const res = await app.inject({
    method: 'POST', url: '/api/conductor/alta', headers: cabeceras(uuid),
    payload: {
      nombre: 'A', telefono: telefonoUnico(),
      matricula: `GE-P${sufijoUnico()}`, marca: 'Kia', carroceria: 'turismo',
    },
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /ya se registró como pasajero/);
});

test('estadísticas: números del pasajero y del taxista, sin inventar nada', async () => {
  const uuid = randomUUID();
  await app.inject({
    method: 'PUT', url: '/api/perfil', headers: cabeceras(uuid), payload: { telefono: '+240222321321' },
  });
  const nuevas = await app.inject({ method: 'GET', url: '/api/estadisticas', headers: cabeceras(uuid) });
  assert.equal(nuevas.json().rol, 'cliente');
  assert.equal(nuevas.json().viajes.pedidos, 0);
  assert.equal(nuevas.json().strikes, 0);
  assert.deepEqual(nuevas.json().destinosFrecuentes, []);

  // Tras pedir un taxi, el contador sube.
  await crearConductorEnZona();
  await pedirTaxi(uuid);
  const despues = await app.inject({ method: 'GET', url: '/api/estadisticas', headers: cabeceras(uuid) });
  assert.equal(despues.json().viajes.pedidos, 1);
  assert.equal(despues.json().destinosFrecuentes[0].nombre, 'Destino API');
});

test('recarga: pedirla NO sube el saldo; solo lo hace la confirmación del operador', async () => {
  const uuid = randomUUID();
  const telefono = telefonoUnico();
  await app.inject({
    method: 'POST', url: '/api/conductor/alta', headers: cabeceras(uuid),
    payload: {
      nombre: 'Recargador', telefono, matricula: `GE-R${sufijoUnico()}`,
      marca: 'Kia', carroceria: 'turismo',
    },
  });
  const sesion = await app.inject({ method: 'GET', url: '/api/sesion', headers: cabeceras(uuid) });
  const conductorId = await pool.query('SELECT id FROM conductor WHERE telefono = $1', [telefono]);
  assert.equal(sesion.json().conductor.saldoXaf, 0);

  const pedida = await app.inject({
    method: 'POST', url: '/api/conductor/recargas', headers: cabeceras(uuid),
    payload: { importeXaf: 6000, metodo: 'muni_dinero' },
  });
  assert.equal(pedida.statusCode, 200, pedida.body);
  const recarga = pedida.json();
  assert.match(recarga.referencia, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  assert.equal(recarga.instrucciones.numero, '555926804');
  assert.match(recarga.instrucciones.texto, /Muni Dinero/);
  assert.match(recarga.instrucciones.texto, new RegExp(recarga.referencia));

  // Lo esencial: pedirla no mueve un franco.
  const saldoTrasPedir = await pool.query(
    'SELECT saldo_xaf FROM saldo_monedero WHERE conductor_id = $1',
    [conductorId.rows[0].id],
  );
  assert.equal(Number(saldoTrasPedir.rows[0].saldo_xaf), 0, 'una recarga pendiente NO da saldo');

  // Pedir otra devuelve la misma: una pendiente a la vez.
  const repetida = await app.inject({
    method: 'POST', url: '/api/conductor/recargas', headers: cabeceras(uuid),
    payload: { importeXaf: 99_000, metodo: 'efectivo' },
  });
  assert.equal(repetida.json().referencia, recarga.referencia);
  assert.equal(repetida.json().importeXaf, 6000, 'no se cambia el importe de una pendiente');

  // El operador confirma: ahora sí.
  const confirmada = await enTransaccion(pool, (c) =>
    confirmarRecarga(c, recarga.referencia, 'operador-prueba'));
  assert.equal(confirmada.yaEstaba, false);
  assert.equal(confirmada.saldoXaf, 6000);

  // Confirmar dos veces no duplica el dinero.
  const otraVez = await enTransaccion(pool, (c) =>
    confirmarRecarga(c, recarga.referencia, 'operador-prueba'));
  assert.equal(otraVez.yaEstaba, true);
  assert.equal(otraVez.saldoXaf, 6000);

  const apuntes = await pool.query(
    `SELECT count(*)::int AS n FROM apunte a JOIN monedero m ON m.id = a.monedero_id
     WHERE m.conductor_id = $1 AND a.tipo = 'recarga'`,
    [conductorId.rows[0].id],
  );
  assert.equal(apuntes.rows[0].n, 1);
});

test('recarga: por debajo del mínimo se rechaza con el motivo', async () => {
  const uuid = randomUUID();
  const telefono = telefonoUnico();
  await app.inject({
    method: 'POST', url: '/api/conductor/alta', headers: cabeceras(uuid),
    payload: {
      nombre: 'Tacaño', telefono, matricula: `GE-T${sufijoUnico()}`,
      marca: 'Kia', carroceria: 'turismo',
    },
  });
  const res = await app.inject({
    method: 'POST', url: '/api/conductor/recargas', headers: cabeceras(uuid),
    payload: { importeXaf: 500, metodo: 'efectivo' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /mínima son 1500 XAF/);

  const malMetodo = await app.inject({
    method: 'POST', url: '/api/conductor/recargas', headers: cabeceras(uuid),
    payload: { importeXaf: 3000, metodo: 'bitcoin' },
  });
  assert.equal(malMetodo.statusCode, 400);
  assert.match(malMetodo.json().error, /muni_dinero o efectivo/);
});

test('el JSON grande viaja comprimido; lo pequeño no se comprime en vano', async () => {
  const grande = await app.inject({
    method: 'GET', url: '/api/mapa', headers: { 'accept-encoding': 'gzip' },
  });
  assert.equal(grande.headers['content-encoding'], 'gzip');
  assert.match(String(grande.headers.vary), /accept-encoding/);

  const sinGzip = await app.inject({ method: 'GET', url: '/api/mapa' });
  assert.equal(sinGzip.headers['content-encoding'], undefined);

  const pequeno = await app.inject({
    method: 'GET', url: '/api/sesion',
    headers: { ...cabeceras(randomUUID()), 'accept-encoding': 'gzip' },
  });
  assert.equal(pequeno.headers['content-encoding'], undefined, 'no merece la pena comprimir migajas');
});

test('perfil: se registra con solo teléfono, o con solo correo, pero no sin ninguno', async () => {
  const sinNada = await app.inject({
    method: 'PUT', url: '/api/perfil', headers: cabeceras(randomUUID()), payload: {},
  });
  assert.equal(sinNada.statusCode, 400);
  assert.match(sinNada.json().error, /teléfono o un correo/);

  const soloTelefono = await app.inject({
    method: 'PUT',
    url: '/api/perfil',
    headers: cabeceras(randomUUID()),
    payload: { telefono: '+240222444555' },
  });
  assert.equal(soloTelefono.statusCode, 200);
  assert.equal(soloTelefono.json().perfil.telefono, '+240222444555');
  assert.equal(soloTelefono.json().perfil.correo, null);

  const soloCorreo = await app.inject({
    method: 'PUT',
    url: '/api/perfil',
    headers: cabeceras(randomUUID()),
    payload: { correo: 'Ana@Example.COM' },
  });
  assert.equal(soloCorreo.statusCode, 200);
  // El correo se normaliza a minúsculas.
  assert.equal(soloCorreo.json().perfil.correo, 'ana@example.com');
});

test('perfil: datos opcionales y validaciones explícitas', async () => {
  const uuid = randomUUID();
  const completo = await app.inject({
    method: 'PUT',
    url: '/api/perfil',
    headers: cabeceras(uuid),
    payload: {
      telefono: '+240222444556', nombre: 'Ana Bindang', edad: 34, genero: 'mujer',
    },
  });
  assert.equal(completo.statusCode, 200);
  assert.deepEqual(completo.json().perfil, {
    telefono: '+240222444556',
    correo: null,
    nombre: 'Ana Bindang',
    edad: 34,
    genero: 'mujer',
  });

  for (const [carga, patron] of [
    [{ telefono: 'abc' }, /Teléfono no válido/],
    [{ correo: 'no-es-correo' }, /Correo no válido/],
    [{ telefono: '+240222444556', edad: 5 }, /edad debe ser/],
    [{ telefono: '+240222444556', genero: 'marciano' }, /Género no válido/],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    const res = await app.inject({
      method: 'PUT', url: '/api/perfil', headers: cabeceras(uuid), payload: carga,
    });
    assert.equal(res.statusCode, 400, JSON.stringify(carga));
    assert.match(res.json().error, patron);
  }

  // El perfil se lee y sigue intacto tras los intentos fallidos.
  const leido = await app.inject({ method: 'GET', url: '/api/perfil', headers: cabeceras(uuid) });
  assert.equal(leido.json().registrado, true);
  assert.equal(leido.json().perfil.nombre, 'Ana Bindang');
});

test('perfil: un dispositivo sin registrar lo dice, y el perfil no es identidad', async () => {
  const uuid = randomUUID();
  const nuevo = await app.inject({ method: 'GET', url: '/api/perfil', headers: cabeceras(uuid) });
  assert.equal(nuevo.json().registrado, false);
  assert.equal(nuevo.json().perfil, null);

  // Dos dispositivos pueden declarar el MISMO teléfono: sin verificación, un
  // único global solo serviría para bloquear al dueño real del número.
  const uno = randomUUID();
  const otro = randomUUID();
  for (const d of [uno, otro]) {
    const res = await app.inject({
      method: 'PUT', url: '/api/perfil', headers: cabeceras(d), payload: { telefono: '+240222999000' },
    });
    assert.equal(res.statusCode, 200);
  }
  // Y los strikes siguen colgando del dispositivo, no del teléfono.
  await pool.query(
    `UPDATE dispositivo SET strikes = 3, bloqueado_en = now() WHERE uuid_persistente = $1`,
    [uno],
  );
  const bloqueado = await app.inject({ method: 'GET', url: '/api/perfil', headers: cabeceras(uno) });
  const libre = await app.inject({ method: 'GET', url: '/api/perfil', headers: cabeceras(otro) });
  assert.equal(bloqueado.json().bloqueado, true);
  assert.equal(libre.json().bloqueado, false, 'el bloqueo no se contagia por compartir teléfono');
});

test('pedir taxi toma el teléfono del perfil sin repetirlo, y falla claro si no hay ninguno', async () => {
  await crearConductorEnZona();
  const uuid = randomUUID();
  await app.inject({
    method: 'PUT', url: '/api/perfil', headers: cabeceras(uuid), payload: { telefono: '+240222777111' },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/solicitudes',
    headers: cabeceras(uuid),
    payload: { origenId, destinoId },
  });
  assert.ok(res.statusCode < 300, res.body);
  const solicitud = await pool.query(
    'SELECT telefono_cliente FROM solicitud WHERE id = $1',
    [res.json().solicitudId],
  );
  assert.equal(solicitud.rows[0].telefono_cliente, '+240222777111');

  // Sin perfil y sin teléfono en el cuerpo: mensaje explícito.
  const sinTelefono = await app.inject({
    method: 'POST',
    url: '/api/solicitudes',
    headers: cabeceras(randomUUID()),
    payload: { origenId, destinoId },
  });
  assert.equal(sinTelefono.statusCode, 400);
  assert.match(sinTelefono.json().error, /teléfono/);
});

test('API: sin cabecera x-dispositivo, 400 explícito', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/solicitudes',
    payload: { telefono: '+240222999992', origenId, destinoId },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /x-dispositivo/);
});

test('API: búsqueda difusa de referencias', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/referencias?q=mercao%20semu' });
  assert.equal(res.statusCode, 200);
  const resultados = res.json() as Array<{ nombre: string }>;
  assert.ok(resultados.some((r) => r.nombre === 'Mercado SEMU'));
});

test('API: una solicitud solo la ve su dispositivo', async () => {
  await crearConductorEnZona();
  const { solicitudId } = await pedirTaxi(randomUUID());
  const ajeno = await app.inject({
    method: 'GET',
    url: `/api/solicitudes/${solicitudId}`,
    headers: cabeceras(randomUUID()),
  });
  assert.equal(ajeno.statusCode, 404);
});

test('API: cancelar durante la emisión libera al conductor ofertado', async () => {
  const conductorId = await crearConductorEnZona();
  const uuid = randomUUID();
  const { solicitudId } = await pedirTaxi(uuid);

  const res = await app.inject({
    method: 'POST',
    url: `/api/solicitudes/${solicitudId}/cancelar`,
    headers: cabeceras(uuid),
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().estado, 'CANCELADO_CLIENTE');
  assert.equal(res.json().strike, false);

  const presencia = await pool.query('SELECT estado FROM presencia WHERE conductor_id = $1', [conductorId]);
  assert.equal(presencia.rows[0].estado, 'DISPONIBLE');
  // El conductor recibe el aviso de que la oferta ya no existe.
  assert.ok(emisor.deTipo('D2_reclamacion_resuelta')
    .some((e) => e.conductorId === conductorId && e.datos.resultado === 'cancelada'));
});

test('API: dispositivo bloqueado no puede pedir', async () => {
  const uuid = randomUUID();
  await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo, strikes, bloqueado_en)
     VALUES ($1, 'cliente', 3, now())`,
    [uuid],
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/solicitudes',
    headers: cabeceras(uuid),
    payload: { telefono: '+240222999992', origenId, destinoId },
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /bloqueado/);
});

test('API: el mapa devuelve referencias con coordenadas reales y se puede cachear', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/mapa' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['cache-control'] as string, /max-age=600/);
  const mapa = res.json() as { referencias: Array<{ nombre: string; lat: number; lng: number }> };
  assert.ok(mapa.referencias.length >= 20);
  // Coordenadas plausibles de Malabo: ~3,7 N y ~8,7 E.
  const central = mapa.referencias.find((r) => r.nombre === 'Mercado Central')!;
  assert.ok(central.lat > 3.7 && central.lat < 3.8, `lat inesperada: ${central.lat}`);
  assert.ok(central.lng > 8.7 && central.lng < 8.8, `lng inesperada: ${central.lng}`);
});

test('API: la búsqueda de referencias incluye coordenadas para el mapa', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/referencias?q=catedral' });
  const resultados = res.json() as Array<{ nombre: string; lat: number; lng: number }>;
  assert.ok(typeof resultados[0].lat === 'number');
  assert.ok(typeof resultados[0].lng === 'number');
});

test('API: posición del taxi y tiempo estimado; el ETA baja al acercarse', async () => {
  const conductorId = await crearConductorEnZona();
  const uuid = randomUUID();
  const { solicitudId } = await pedirTaxi(uuid);
  const reclamacion = await reclamarSolicitud(pool, emisor, solicitudId, conductorId);
  assert.equal(reclamacion.gano, true);

  // Sin posición del conductor no se inventa un tiempo.
  const sinPosicion = await app.inject({
    method: 'GET', url: `/api/solicitudes/${solicitudId}`, headers: cabeceras(uuid),
  });
  assert.equal(sinPosicion.json().taxi, null);

  // El coche a ~1,1 km del origen (3.75, 8.78) y luego a ~330 m.
  await enTransaccion(pool, (c) =>
    registrarPosicion(c, reclamacion.viajeId!, 'conductor', 3.7600, 8.7800));
  const lejos = await app.inject({
    method: 'GET', url: `/api/solicitudes/${solicitudId}`, headers: cabeceras(uuid),
  });
  const taxiLejos = lejos.json().taxi;
  assert.ok(taxiLejos.etaMin >= 1, 'debe dar algún minuto');
  assert.ok(taxiLejos.distanciaM > 1000, `distancia inesperada: ${taxiLejos.distanciaM}`);

  await enTransaccion(pool, (c) =>
    registrarPosicion(c, reclamacion.viajeId!, 'conductor', 3.7530, 8.7800));
  const cerca = await app.inject({
    method: 'GET', url: `/api/solicitudes/${solicitudId}`, headers: cabeceras(uuid),
  });
  const taxiCerca = cerca.json().taxi;
  assert.ok(taxiCerca.distanciaM < taxiLejos.distanciaM, 'al acercarse la distancia baja');
  assert.ok(taxiCerca.etaMin <= taxiLejos.etaMin, 'al acercarse el tiempo no sube');
});

test('API: valoración del conductor, idempotente y reflejada en su reputación', async () => {
  const conductorId = await crearConductorEnZona();
  const uuid = randomUUID();
  const { solicitudId } = await pedirTaxi(uuid);
  const reclamacion = await reclamarSolicitud(pool, emisor, solicitudId, conductorId);

  // Antes de recoger no se puede valorar.
  const pronto = await app.inject({
    method: 'POST',
    url: `/api/solicitudes/${solicitudId}/valoracion`,
    headers: cabeceras(uuid),
    payload: { puntuacion: 5 },
  });
  assert.equal(pronto.statusCode, 409);

  await enTransaccion(pool, (c) => transicionarSolicitud(c, solicitudId, 'EN_CAMINO', 'conductor'));
  await enTransaccion(pool, (c) => transicionarSolicitud(c, solicitudId, 'RECOGIDO', 'conductor'));

  // Puntuación fuera de rango: 400 explícito.
  const invalida = await app.inject({
    method: 'POST',
    url: `/api/solicitudes/${solicitudId}/valoracion`,
    headers: cabeceras(uuid),
    payload: { puntuacion: 9 },
  });
  assert.equal(invalida.statusCode, 400);

  const primera = await app.inject({
    method: 'POST',
    url: `/api/solicitudes/${solicitudId}/valoracion`,
    headers: cabeceras(uuid),
    payload: { puntuacion: 4 },
  });
  assert.deepEqual(primera.json(), { guardada: true, repetida: false });

  const repetida = await app.inject({
    method: 'POST',
    url: `/api/solicitudes/${solicitudId}/valoracion`,
    headers: cabeceras(uuid),
    payload: { puntuacion: 1 },
  });
  assert.deepEqual(repetida.json(), { guardada: false, repetida: true });

  const reputacion = await reputacionDe(pool, conductorId);
  assert.equal(reputacion.media, 4, 'la segunda valoración no cambia la nota');
  assert.equal(reputacion.valoraciones, 1);
  // Y llega al cliente en el detalle de la solicitud.
  const detalle = await app.inject({
    method: 'GET', url: `/api/solicitudes/${solicitudId}`, headers: cabeceras(uuid),
  });
  assert.equal(detalle.json().reputacion.media, 4);
  assert.ok(reclamacion.viajeId! > 0);
});

test('API: un conductor sin valoraciones se presenta como nuevo, no con un cero', async () => {
  const conductorId = await crearConductorEnZona();
  const reputacion = await reputacionDe(pool, conductorId);
  assert.equal(reputacion.media, null);
  assert.equal(reputacion.valoraciones, 0);
});

test('API: el cliente ve matrícula y datos del coche, y su sesión no le pide nada al final', async () => {
  const conductorId = await crearConductorEnZona();
  const uuid = randomUUID();
  const { solicitudId } = await pedirTaxi(uuid);

  // El conductor gana la reclamación y llega hasta RECOGIDO (dominio; la API
  // del conductor es del paso 8).
  const reclamacion = await reclamarSolicitud(pool, emisor, solicitudId, conductorId);
  assert.equal(reclamacion.gano, true);
  await enTransaccion(pool, (c) => transicionarSolicitud(c, solicitudId, 'EN_CAMINO', 'conductor'));
  await enTransaccion(pool, (c) => transicionarSolicitud(c, solicitudId, 'RECOGIDO', 'conductor'));

  const estado = await app.inject({
    method: 'GET',
    url: `/api/solicitudes/${solicitudId}`,
    headers: cabeceras(uuid),
  });
  const detalle = estado.json();
  assert.equal(detalle.estado, 'RECOGIDO');
  assert.match(detalle.matricula, /^GE-/);
  // El teléfono del conductor nunca se expone al cliente (es él quien llama).
  assert.ok(!Object.keys(detalle).some((clave) => clave.toLowerCase().includes('telefono')));

  // El endpoint de precio ya no existe (migración 012): cero fricción final.
  const precio = await app.inject({
    method: 'POST',
    url: `/api/solicitudes/${solicitudId}/precio`,
    headers: cabeceras(uuid),
    payload: { precioXaf: 1500 },
  });
  assert.equal(precio.statusCode, 404);
});

// --- Llamadas dentro de la aplicación ---------------------------------------
//
// Lo que se fija aquí no es que el audio suene —eso pasa entre los dos
// teléfonos y no toca este servidor— sino QUIÉN puede abrir un canal hacia
// quién. Esa es la única garantía de privacidad que depende del servidor: si
// se rompe, cualquiera podría hacer sonar el teléfono de un desconocido.

// Un dispositivo de conductor, que la semilla de estas pruebas no crea.
async function dispositivoDeConductor(conductorId: number): Promise<string> {
  const uuid = randomUUID();
  await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id)
     VALUES ($1, 'conductor', $2)`,
    [uuid, conductorId],
  );
  return uuid;
}

// Deja un viaje aceptado y devuelve las dos identidades y sus dispositivos.
async function viajeAceptado() {
  const conductorId = await crearConductorEnZona();
  const uuidCliente = randomUUID();
  const { solicitudId } = await pedirTaxi(uuidCliente);
  await reclamarSolicitud(pool, emisor, solicitudId, conductorId);
  const uuidConductor = await dispositivoDeConductor(conductorId);
  const dispositivoCliente = await pool.query(
    'SELECT id FROM dispositivo WHERE uuid_persistente = $1', [uuidCliente],
  );
  const dispositivoConductor = await pool.query(
    'SELECT id FROM dispositivo WHERE uuid_persistente = $1', [uuidConductor],
  );
  return {
    solicitudId,
    conductorId,
    uuidCliente,
    uuidConductor,
    idCliente: Number(dispositivoCliente.rows[0].id),
    idConductor: Number(dispositivoConductor.rows[0].id),
  };
}

function senal(uuid: string, solicitudId: number, tipo: string, carga: unknown = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/solicitudes/${solicitudId}/senal`,
    headers: cabeceras(uuid),
    payload: { tipo, carga },
  });
}

test('llamada: el pasajero y su taxista se alcanzan, y la señal llega al otro', async () => {
  const v = await viajeAceptado();

  // Se escucha por el conductor como haría su aplicación abierta.
  const recibidas: string[] = [];
  const baja = conexionesSse.suscribir(v.idConductor, (carga) => recibidas.push(carga));

  const res = await senal(v.uuidCliente, v.solicitudId, 'oferta', { sdp: 'v=0' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().entregada, true, 'con la app abierta, la señal se entrega');
  assert.equal(recibidas.length, 1);
  const mensaje = JSON.parse(recibidas[0]);
  assert.equal(mensaje.tipo, 'llamada');
  assert.equal(Number(mensaje.solicitudId), Number(v.solicitudId));
  assert.equal(mensaje.datos.senal, 'oferta');
  assert.equal(mensaje.datos.deConductor, false, 'el que llama es el pasajero');
  baja();

  // Y en sentido contrario.
  const haciaCliente: string[] = [];
  const baja2 = conexionesSse.suscribir(v.idCliente, (carga) => haciaCliente.push(carga));
  const vuelta = await senal(v.uuidConductor, v.solicitudId, 'respuesta', { sdp: 'v=0' });
  assert.equal(vuelta.statusCode, 200, vuelta.body);
  assert.equal(JSON.parse(haciaCliente[0]).datos.deConductor, true);
  baja2();
});

test('llamada: sin la aplicación abierta se dice que no se entregó, no se finge', async () => {
  const v = await viajeAceptado();
  const res = await senal(v.uuidCliente, v.solicitudId, 'oferta', { sdp: 'v=0' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().entregada, false,
    'quien llama tiene que poder distinguir «está sonando» de «tiene la app cerrada»');
});

test('llamada: un tercero NO puede abrir un canal hacia los de un viaje ajeno', async () => {
  const v = await viajeAceptado();
  // Un usuario de verdad, con su propio viaje: el caso que importa no es el
  // de un desconocido sin cuenta, sino el del vecino que sí usa la aplicación
  // y se pone a probar identificadores de solicitud ajenos.
  const intruso = randomUUID();
  await crearConductorEnZona();
  await pedirTaxi(intruso);

  const res = await senal(intruso, v.solicitudId, 'oferta', { sdp: 'v=0' });
  assert.equal(res.statusCode, 403, res.body);
  // Ni siquiera se le confirma que el viaje exista.
  assert.doesNotMatch(res.json().error, /estado|conductor|pasajero/i);
});

test('llamada: no se puede llamar antes de que el taxi acepte', async () => {
  await crearConductorEnZona();
  const uuid = randomUUID();
  const { solicitudId } = await pedirTaxi(uuid); // queda EMITIDO
  const res = await senal(uuid, solicitudId, 'oferta', { sdp: 'v=0' });
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.json().error, /en curso/);
});

test('llamada: al terminar el viaje se cierra el canal', async () => {
  const v = await viajeAceptado();
  await enTransaccion(pool, async (c) => {
    await transicionarSolicitud(c, v.solicitudId, 'EN_CAMINO', 'conductor', 'prueba');
    await transicionarSolicitud(c, v.solicitudId, 'RECOGIDO', 'conductor', 'prueba');
    await transicionarSolicitud(c, v.solicitudId, 'COMPLETADO', 'conductor', 'prueba');
  });
  const res = await senal(v.uuidCliente, v.solicitudId, 'oferta', { sdp: 'v=0' });
  assert.equal(res.statusCode, 409,
    'después de bajarse ya no se puede hacer sonar el teléfono del otro');
});

test('llamada: el canal solo admite las señales del apretón de manos', async () => {
  const v = await viajeAceptado();
  const inventada = await senal(v.uuidCliente, v.solicitudId, 'mensaje', { texto: 'hola' });
  assert.equal(inventada.statusCode, 400, 'no es un buzón de mensajes entre desconocidos');

  const enorme = await senal(v.uuidCliente, v.solicitudId, 'oferta', { sdp: 'x'.repeat(20_000) });
  assert.equal(enorme.statusCode, 413);
});

test('llamada: las credenciales del puente solo se dan a quien va en el viaje', async () => {
  const v = await viajeAceptado();
  const url = `/api/solicitudes/${v.solicitudId}/llamada/configuracion`;

  const mia = await app.inject({ method: 'GET', url, headers: cabeceras(v.uuidCliente) });
  assert.equal(mia.statusCode, 200, mia.body);
  assert.ok(Array.isArray(mia.json().servidores) && mia.json().servidores.length > 0);
  // Nunca en caché: cada llamada recibe credenciales nuevas.
  assert.match(mia.headers['cache-control'] as string, /no-store/);

  // Un usuario cualquiera no puede sacarle credenciales al puente. Si pudiera,
  // sería ancho de banda gratis a costa de quien lo aloja.
  const intruso = randomUUID();
  await crearConductorEnZona();
  await pedirTaxi(intruso);
  const ajena = await app.inject({ method: 'GET', url, headers: cabeceras(intruso) });
  assert.equal(ajena.statusCode, 403, ajena.body);
});

test('llamada: las credenciales del puente caducan y no repiten usuario', () => {
  const ahora = 1_700_000_000;
  const a = credencialesEfimeras('secreto-de-prueba', ahora);
  const b = credencialesEfimeras('secreto-de-prueba', ahora);

  // Usuario con forma «<caducidad>:<aleatorio>», que es lo que espera coturn.
  const [caducidad, aleatorio] = a.username.split(':');
  assert.ok(Number(caducidad) > ahora, 'la credencial tiene que caducar en el futuro');
  assert.ok(Number(caducidad) - ahora <= 3600, 'y no durar más de una hora');
  assert.ok(aleatorio.length >= 8);

  // El identificador es aleatorio: dos peticiones seguidas no dan el mismo, y
  // así el log del puente no puede reconstruir quién viajó con quién.
  assert.notEqual(a.username, b.username);

  // La clave es la firma del usuario con el secreto, no el secreto.
  assert.doesNotMatch(a.credential, /secreto-de-prueba/);
  const esperada = createHmac('sha1', 'secreto-de-prueba').update(a.username).digest('base64');
  assert.equal(a.credential, esperada);
});

// --- Destinos de un toque ---------------------------------------------------
//
// Escribir es la barrera más alta de la aplicación: quien no escribe con
// soltura no puede pedir un taxi por muy bien que funcione todo lo demás. Estas
// pruebas fijan que la lista sirva para el caso que importa —el usuario que
// repite trayectos— y que el usuario NUEVO, que es el que más ayuda necesita,
// tampoco se quede con la pantalla vacía.

test('destinos: se ofrecen los sitios a los que ya ha ido, los más repetidos primero', async () => {
  await crearConductorEnZona();
  const uuid = randomUUID();

  // Dos viajes al mismo sitio y uno a otro distinto.
  const otro = (await enTransaccion(pool, (c) => guardarReferencia(c, {
    zonaId, nombre: `Destino Ocasional ${randomUUID()}`, lat: 3.752, lng: 8.782,
  }))).referenciaId;
  await pedirTaxi(uuid);
  await app.inject({
    method: 'POST', url: '/api/solicitudes', headers: cabeceras(uuid),
    payload: { telefono: '+240222999992', origenId, destinoId: otro },
  });
  // Otra vez al primero, para que pase a ser el más repetido. Desde OTRO
  // origen a propósito: la clave de idempotencia agrupa por (dispositivo,
  // origen, destino, ventana de 60 s), así que repetir el mismo trayecto aquí
  // mismo no crearía una segunda solicitud.
  const otroOrigen = (await enTransaccion(pool, (c) => guardarReferencia(c, {
    zonaId, nombre: `Origen Alterno ${randomUUID()}`, lat: 3.749, lng: 8.779,
  }))).referenciaId;
  await app.inject({
    method: 'POST', url: '/api/solicitudes', headers: cabeceras(uuid),
    payload: { telefono: '+240222999992', origenId: otroOrigen, destinoId },
  });

  const res = await app.inject({
    method: 'GET', url: '/api/destinos-sugeridos', headers: cabeceras(uuid),
  });
  assert.equal(res.statusCode, 200, res.body);
  const lista = res.json() as Array<{ nombre: string; motivo: string; lat: number }>;
  assert.ok(lista.length >= 2, `se esperaban al menos 2 destinos, hubo ${lista.length}`);
  assert.equal(lista[0].nombre, 'Destino API', 'el más repetido va primero');
  assert.ok(lista.every((d) => d.motivo === 'tuyo'));
  // Con coordenadas: la pantalla las necesita para pedir sin volver a buscar.
  assert.equal(typeof lista[0].lat, 'number');
});

test('destinos: el usuario nuevo no se queda sin nada; se le ofrecen los de su zona', async () => {
  await crearConductorEnZona();
  // Alguien crea historial en la zona para que haya qué ofrecer.
  const veterano = randomUUID();
  await pedirTaxi(veterano);

  const nuevo = randomUUID();
  const res = await app.inject({
    method: 'GET',
    url: `/api/destinos-sugeridos?origenId=${origenId}`,
    headers: cabeceras(nuevo),
  });
  assert.equal(res.statusCode, 200, res.body);
  const lista = res.json() as Array<{ id: string; motivo: string }>;
  assert.ok(lista.length > 0, 'sin historial propio hay que tirar de los de la zona');
  assert.ok(lista.every((d) => d.motivo === 'zona'));
});

test('destinos: nunca se ofrece como destino el sitio donde ya estás', async () => {
  await crearConductorEnZona();
  const uuid = randomUUID();
  await pedirTaxi(uuid);

  // Se pide con el propio destino como origen: no puede volver a salir.
  const res = await app.inject({
    method: 'GET',
    url: `/api/destinos-sugeridos?origenId=${destinoId}`,
    headers: cabeceras(uuid),
  });
  const lista = res.json() as Array<{ id: string }>;
  assert.ok(!lista.some((d) => String(d.id) === String(destinoId)),
    'ofrecer «ve a donde ya estás» es ruido en la única lista que se lee de un vistazo');
});

// --- Cuenta atrás de la cancelación gratuita --------------------------------
//
// El pasajero tiene 60 s desde que el taxi acepta para cancelar sin que le
// cueste un aviso; a los tres avisos se le bloquea el servicio. Antes eso se
// contaba con la frase «gratis el primer minuto» y sin reloj, así que no había
// forma de saber si cancelar salía gratis. Estas pruebas fijan el dato con el
// que la pantalla dibuja la cuenta atrás.

test('gracia: mientras se busca taxi no hay cuenta atrás, porque cancelar es gratis', async () => {
  await crearConductorEnZona();
  const uuid = randomUUID();
  const { solicitudId } = await pedirTaxi(uuid);

  const res = await app.inject({
    method: 'GET', url: `/api/solicitudes/${solicitudId}`, headers: cabeceras(uuid),
  });
  assert.equal(res.json().estado, 'EMITIDO');
  assert.equal(res.json().graciaCancelacionSeg, null,
    'sin taxi asignado no hay nada que contar: cancelar nunca cuesta');
});

test('gracia: con taxi asignado se dicen los segundos que quedan, y van bajando', async () => {
  const conductorId = await crearConductorEnZona();
  const uuid = randomUUID();
  const { solicitudId } = await pedirTaxi(uuid);
  await reclamarSolicitud(pool, emisor, solicitudId, conductorId);

  const recien = await app.inject({
    method: 'GET', url: `/api/solicitudes/${solicitudId}`, headers: cabeceras(uuid),
  });
  const seg = recien.json().graciaCancelacionSeg as number;
  assert.equal(recien.json().estado, 'ACEPTADO');
  assert.ok(seg > 55 && seg <= 60, `recién aceptado deberían quedar ~60 s, quedan ${seg}`);

  await new Promise((r) => setTimeout(r, 1500));
  const despues = await app.inject({
    method: 'GET', url: `/api/solicitudes/${solicitudId}`, headers: cabeceras(uuid),
  });
  assert.ok((despues.json().graciaCancelacionSeg as number) < seg,
    'la cuenta atrás tiene que bajar sola');
});

test('gracia: nunca baja de cero, para que la pantalla no enseñe segundos negativos', async () => {
  const conductorId = await crearConductorEnZona();
  const uuid = randomUUID();
  const { solicitudId } = await pedirTaxi(uuid);
  await reclamarSolicitud(pool, emisor, solicitudId, conductorId);

  // El registro de transiciones es de solo inserción (hay un disparador que lo
  // impide), así que no se puede envejecer la aceptación: se acorta el plazo,
  // que es el mismo efecto sin falsear el historial.
  const antes = await pool.query(
    "SELECT valor FROM parametro WHERE clave = 'gracia_cancelacion_cliente_seg'",
  );
  await pool.query(
    "UPDATE parametro SET valor = '0' WHERE clave = 'gracia_cancelacion_cliente_seg'",
  );
  try {
    const res = await app.inject({
      method: 'GET', url: `/api/solicitudes/${solicitudId}`, headers: cabeceras(uuid),
    });
    assert.equal(res.json().graciaCancelacionSeg, 0, 'nunca negativo');

    // Y el servidor cobra el aviso, que es justo lo que la pantalla anuncia.
    const cancelacion = await app.inject({
      method: 'POST', url: `/api/solicitudes/${solicitudId}/cancelar`,
      headers: cabeceras(uuid), payload: {},
    });
    assert.equal(cancelacion.json().strike, true,
      'lo que dice la pantalla y lo que hace el servidor tienen que coincidir');
  } finally {
    await pool.query(
      'UPDATE parametro SET valor = $1 WHERE clave = $2',
      [antes.rows[0].valor, 'gracia_cancelacion_cliente_seg'],
    );
  }
});

test('deshacer: cancelar recién pedido, sin taxi todavía, no cuesta aviso', async () => {
  await crearConductorEnZona();
  const uuid = randomUUID();
  const { solicitudId } = await pedirTaxi(uuid);

  const res = await app.inject({
    method: 'POST', url: `/api/solicitudes/${solicitudId}/cancelar`,
    headers: cabeceras(uuid), payload: {},
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().strike, false,
    'el botón de deshacer promete que no cuesta nada; esto es lo que lo sostiene');
});

// --- El número que confirma el taxi -----------------------------------------
//
// Sirve para que el taxista sepa cuál de las tres personas que esperan en la
// esquina es la suya, sin saber su nombre (el diseño no lo comparte). Todo el
// mecanismo se apoya en una cosa: que el taxista NO pueda verlo por su cuenta.
// Si pudiera, preguntarlo no probaría nada.

test('número: el pasajero lo ve; el taxista no puede leerlo por su API', async () => {
  const conductorId = await crearConductorEnZona();
  const uuidCliente = randomUUID();
  const { solicitudId } = await pedirTaxi(uuidCliente);
  await reclamarSolicitud(pool, emisor, solicitudId, conductorId);

  const delPasajero = await app.inject({
    method: 'GET', url: `/api/solicitudes/${solicitudId}`, headers: cabeceras(uuidCliente),
  });
  const pin = delPasajero.json().pin as string;
  assert.match(pin, /^[0-9]{4}$/, 'el pasajero necesita verlo para dictarlo');

  // El taxista, en cambio, no lo recibe por ninguna vía suya.
  const uuidConductor = randomUUID();
  await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id) VALUES ($1, 'conductor', $2)`,
    [uuidConductor, conductorId],
  );
  const delConductor = await app.inject({
    method: 'GET', url: '/api/conductor/estado', headers: cabeceras(uuidConductor),
  });
  assert.ok(!JSON.stringify(delConductor.json()).includes(pin),
    'si el taxista pudiera leer el número, comprobarlo no probaría nada');
});

test('número: confirmar la recogida sigue siendo posible SIN él', async () => {
  const conductorId = await crearConductorEnZona();
  const uuidCliente = randomUUID();
  const { solicitudId } = await pedirTaxi(uuidCliente);
  await reclamarSolicitud(pool, emisor, solicitudId, conductorId);
  const uuidConductor = randomUUID();
  await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id) VALUES ($1, 'conductor', $2)`,
    [uuidConductor, conductorId],
  );
  await app.inject({
    method: 'POST', url: `/api/conductor/solicitudes/${solicitudId}/salir`,
    headers: cabeceras(uuidConductor), payload: {},
  });

  // Sin número: la confirmación manual es el camino de todos los días y no
  // puede empeorar por haber añadido la comprobación opcional.
  const res = await app.inject({
    method: 'POST', url: `/api/conductor/solicitudes/${solicitudId}/recoger`,
    headers: cabeceras(uuidConductor), payload: {},
  });
  assert.equal(res.statusCode, 200, res.body);

  const transicion = await pool.query(
    `SELECT origen_evento FROM transicion
     WHERE solicitud_id = $1 AND estado_nuevo = 'RECOGIDO' ORDER BY id DESC LIMIT 1`,
    [solicitudId],
  );
  assert.equal(transicion.rows[0].origen_evento, 'confirmacion_manual',
    'queda anotado por qué vía se confirmó, que es lo que permite auditarlo después');
});

test('número: con él, queda anotado que se comprobó de verdad', async () => {
  const conductorId = await crearConductorEnZona();
  const uuidCliente = randomUUID();
  const { solicitudId } = await pedirTaxi(uuidCliente);
  await reclamarSolicitud(pool, emisor, solicitudId, conductorId);
  const uuidConductor = randomUUID();
  await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id) VALUES ($1, 'conductor', $2)`,
    [uuidConductor, conductorId],
  );
  await app.inject({
    method: 'POST', url: `/api/conductor/solicitudes/${solicitudId}/salir`,
    headers: cabeceras(uuidConductor), payload: {},
  });

  const pin = (await app.inject({
    method: 'GET', url: `/api/solicitudes/${solicitudId}`, headers: cabeceras(uuidCliente),
  })).json().pin as string;

  // Uno equivocado no cuela, y el mensaje dice qué hacer.
  const malo = await app.inject({
    method: 'POST', url: `/api/conductor/solicitudes/${solicitudId}/recoger`,
    headers: cabeceras(uuidConductor), payload: { pin: pin === '0000' ? '1111' : '0000' },
  });
  assert.equal(malo.statusCode, 400, malo.body);
  assert.match(malo.json().error, /dicte otra vez/);

  const bueno = await app.inject({
    method: 'POST', url: `/api/conductor/solicitudes/${solicitudId}/recoger`,
    headers: cabeceras(uuidConductor), payload: { pin },
  });
  assert.equal(bueno.statusCode, 200, bueno.body);

  const transicion = await pool.query(
    `SELECT origen_evento FROM transicion
     WHERE solicitud_id = $1 AND estado_nuevo = 'RECOGIDO' ORDER BY id DESC LIMIT 1`,
    [solicitudId],
  );
  assert.equal(transicion.rows[0].origen_evento, 'pin_validado');
});

test('señal de vida: responde sin cabeceras ni base de datos (healthCheckPath)', async () => {
  // Sin x-dispositivo a propósito: el sondeo del hosting no tiene identidad.
  const r = await app.inject({ method: 'GET', url: '/api/vivo' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { vivo: true });
});

// --- El teléfono como clave de identidad (migración 024) --------------------

test('reinstalar NO limpia el bloqueo: las sanciones siguen al número', async () => {
  const telefono = telefonoUnico().slice(0, 13);
  const viejo = randomUUID();

  // Se registra, y acumula sanción hasta quedar bloqueado.
  const alta = await app.inject({
    method: 'PUT', url: '/api/perfil', headers: cabeceras(viejo),
    payload: { telefono },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  await pool.query(
    `UPDATE dispositivo SET strikes = 3, bloqueado_en = now() WHERE uuid_persistente = $1`,
    [viejo],
  );
  const bloqueado = await app.inject({
    method: 'POST', url: '/api/solicitudes', headers: cabeceras(viejo),
    payload: { origenId, destinoId },
  });
  assert.equal(bloqueado.statusCode, 403, 'bloqueado no puede pedir');

  // Reinstala: uuid nuevo, mismo número. Antes de la 024 esto daba una
  // identidad limpia y el bloqueo se esquivaba borrando datos del navegador.
  const nuevo = randomUUID();
  const reclamo = await app.inject({
    method: 'PUT', url: '/api/perfil', headers: cabeceras(nuevo),
    // Y escrito de otra forma, para que además pruebe la normalización.
    payload: { telefono: telefono.replace('+240', '') },
  });
  assert.equal(reclamo.statusCode, 200, reclamo.body);

  const tras = await pool.query(
    'SELECT strikes, bloqueado_en FROM dispositivo WHERE uuid_persistente = $1',
    [nuevo],
  );
  assert.equal(tras.rows[0].strikes, 3, 'los avisos siguen al número');
  assert.notEqual(tras.rows[0].bloqueado_en, null, 'y el bloqueo también');

  const sigueBloqueado = await app.inject({
    method: 'POST', url: '/api/solicitudes', headers: cabeceras(nuevo),
    payload: { origenId, destinoId },
  });
  assert.equal(sigueBloqueado.statusCode, 403, 'reinstalar no es una puerta de atrás');

  // Un número, un dispositivo vigente: el anterior deja de tenerlo.
  const vigentes = await pool.query(
    `SELECT count(*)::int AS n FROM perfil_cliente
     WHERE telefono = $1 AND telefono_vigente`,
    [telefono],
  );
  assert.equal(vigentes.rows[0].n, 1, 'solo uno puede tener el número vigente');
});

test('reclamar un número NO entrega el historial de viajes de quien lo tenía', async () => {
  await crearConductorEnZona();
  const telefono = telefonoUnico().slice(0, 13);
  const primero = randomUUID();
  await app.inject({
    method: 'PUT', url: '/api/perfil', headers: cabeceras(primero), payload: { telefono },
  });
  // Hace un viaje, que queda en SU historial.
  await pedirTaxi(primero);

  const segundo = randomUUID();
  await app.inject({
    method: 'PUT', url: '/api/perfil', headers: cabeceras(segundo), payload: { telefono },
  });

  // Decisión explícita de la migración 024: las sanciones siguen al número, el
  // historial no. Si viajara, cualquiera que conozca tu teléfono vería a dónde
  // sueles ir con solo teclearlo.
  const suyos = await pool.query(
    `SELECT count(*)::int AS n FROM solicitud s
     JOIN dispositivo d ON d.id = s.dispositivo_cliente_id
     WHERE d.uuid_persistente = $1`,
    [segundo],
  );
  assert.equal(suyos.rows[0].n, 0, 'el historial se queda con quien lo hizo');
});

test('el mismo número escrito de otra forma no crea una segunda identidad', async () => {
  const local = `2228${sufijoUnico()}`.slice(0, 9);
  const uuid = randomUUID();

  await app.inject({
    method: 'PUT', url: '/api/perfil', headers: cabeceras(uuid), payload: { telefono: local },
  });
  const conPrefijo = await app.inject({
    method: 'PUT', url: '/api/perfil', headers: cabeceras(uuid),
    payload: { telefono: `+240 ${local}` },
  });
  assert.equal(conPrefijo.statusCode, 200);
  // Guardado siempre en forma canónica, no como lo teclearon.
  assert.equal(conPrefijo.json().perfil.telefono, `+240${local}`);
});

// --- «Mírame llegar» (migración 043) ---------------------------------------

// Un pasajero con el teléfono ya verificado: es la puerta de entrada de todo
// esto, así que casi ninguna prueba de aquí tiene sentido sin él.
async function pasajeroVerificado(uuid: string, telefono = telefonoUnico()): Promise<void> {
  const res = await app.inject({
    method: 'PUT', url: '/api/perfil', headers: cabeceras(uuid),
    payload: { telefono, nombre: 'Pasajera SEG' },
  });
  assert.ok(res.statusCode < 300, `perfil falló: ${res.statusCode} ${res.body}`);
  await pool.query(
    `UPDATE perfil_cliente SET telefono_verificado_en = now()
     WHERE dispositivo_id = (SELECT id FROM dispositivo WHERE uuid_persistente = $1)`,
    [uuid],
  );
}

// Un viaje en marcha, con taxi asignado y en camino.
async function viajeEnMarcha(uuid: string): Promise<number> {
  const conductorId = await crearConductorEnZona();
  await pasajeroVerificado(uuid);
  const { solicitudId } = await pedirTaxi(uuid);
  await reclamarSolicitud(pool, emisor, solicitudId, conductorId);
  await enTransaccion(pool, (c) =>
    transicionarSolicitud(c, solicitudId, 'EN_CAMINO', 'conductor', 'prueba'));
  return solicitudId;
}

test('seguimiento: sin el teléfono verificado no se puede compartir el viaje', async () => {
  const conductorId = await crearConductorEnZona();
  const uuid = randomUUID();
  const { solicitudId } = await pedirTaxi(uuid);
  await reclamarSolicitud(pool, emisor, solicitudId, conductorId);

  const res = await app.inject({
    method: 'POST', url: `/api/solicitudes/${solicitudId}/seguimiento`,
    headers: cabeceras(uuid), payload: {},
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /[Vv]erifica tu teléfono/);
});

test('seguimiento: quien MIRA también tiene que verificar su número', async () => {
  const pasajera = randomUUID();
  const solicitudId = await viajeEnMarcha(pasajera);
  const { token } = (await app.inject({
    method: 'POST', url: `/api/solicitudes/${solicitudId}/seguimiento`,
    headers: cabeceras(pasajera), payload: {},
  })).json();
  assert.ok(token, 'debería devolver un token');

  // Una desconocida con el enlace, sin número confirmado: no ve nada. Es la
  // decisión que distingue esto de un enlace de Uber, y cuesta un SMS por
  // persona, así que más vale que esté fijada por una prueba.
  const curiosa = randomUUID();
  const negado = await app.inject({
    method: 'GET', url: `/api/seguimiento/${token}`, headers: cabeceras(curiosa),
  });
  assert.equal(negado.statusCode, 403);

  await pasajeroVerificado(curiosa);
  const visto = await app.inject({
    method: 'GET', url: `/api/seguimiento/${token}`, headers: cabeceras(curiosa),
  });
  assert.equal(visto.statusCode, 200, visto.body);
  assert.equal(visto.json().enMarcha, true);
});

test('seguimiento: quien mira ve el coche, y NO el teléfono ni el PIN', async () => {
  const pasajera = randomUUID();
  const solicitudId = await viajeEnMarcha(pasajera);
  const { token } = (await app.inject({
    method: 'POST', url: `/api/solicitudes/${solicitudId}/seguimiento`,
    headers: cabeceras(pasajera), payload: {},
  })).json();
  const seguidora = randomUUID();
  await pasajeroVerificado(seguidora);

  const res = await app.inject({
    method: 'GET', url: `/api/seguimiento/${token}`, headers: cabeceras(seguidora),
  });
  const vista = res.json();
  // La mitad del valor de esto es poder decir «se subió al GE-1234».
  assert.ok(vista.matricula, 'la matrícula identifica el coche');
  assert.ok(vista.conductor, 'y el nombre del conductor');
  assert.ok(vista.destino, 'y a dónde va');
  // Y la otra mitad es lo que NO viaja: el PIN es la prueba de identidad del
  // viaje, y los teléfonos no son asunto de quien mira.
  const crudo = JSON.stringify(vista);
  assert.equal('pin' in vista, false, 'el PIN de recogida no sale de aquí');
  assert.equal(/\+240\d/.test(crudo), false, `se ha colado un teléfono: ${crudo}`);
});

test('seguimiento: cortarlo mata el enlace, y compartir dos veces no deja dos vivos', async () => {
  const pasajera = randomUUID();
  const solicitudId = await viajeEnMarcha(pasajera);
  const { token } = (await app.inject({
    method: 'POST', url: `/api/solicitudes/${solicitudId}/seguimiento`,
    headers: cabeceras(pasajera), payload: {},
  })).json();

  // Dos veces seguidas no puede dejar dos enlaces vivos: cortar uno dejaría
  // el otro abierto sin que la pasajera lo supiera.
  const repetido = await app.inject({
    method: 'POST', url: `/api/solicitudes/${solicitudId}/seguimiento`,
    headers: cabeceras(pasajera), payload: {},
  });
  assert.equal(repetido.statusCode, 409);

  const seguidora = randomUUID();
  await pasajeroVerificado(seguidora);
  assert.equal((await app.inject({
    method: 'GET', url: `/api/seguimiento/${token}`, headers: cabeceras(seguidora),
  })).statusCode, 200);

  await app.inject({
    method: 'POST', url: `/api/solicitudes/${solicitudId}/seguimiento/revocar`,
    headers: cabeceras(pasajera), payload: {},
  });
  assert.equal((await app.inject({
    method: 'GET', url: `/api/seguimiento/${token}`, headers: cabeceras(seguidora),
  })).statusCode, 404, 'cortado es cortado');
});

test('seguimiento: la pasajera ve quién está mirando su viaje', async () => {
  const pasajera = randomUUID();
  const solicitudId = await viajeEnMarcha(pasajera);
  const { token } = (await app.inject({
    method: 'POST', url: `/api/solicitudes/${solicitudId}/seguimiento`,
    headers: cabeceras(pasajera), payload: {},
  })).json();

  const seguidora = randomUUID();
  const telefonoSeguidora = telefonoUnico();
  await pasajeroVerificado(seguidora, telefonoSeguidora);
  await app.inject({ method: 'GET', url: `/api/seguimiento/${token}`, headers: cabeceras(seguidora) });
  // Mirar dos veces es una visita, no dos: la lista es de personas.
  await app.inject({ method: 'GET', url: `/api/seguimiento/${token}`, headers: cabeceras(seguidora) });

  const estado = (await app.inject({
    method: 'GET', url: `/api/solicitudes/${solicitudId}/seguimiento`,
    headers: cabeceras(pasajera), payload: {},
  })).json();
  assert.equal(estado.activo, true);
  assert.equal(estado.visitas.length, 1);
  // Entero, no medio: la pasajera tiene que poder reconocer el de su madre.
  assert.equal(estado.visitas[0].telefono, telefonoSeguidora);
});

test('seguimiento: un token inventado no abre nada', async () => {
  const curiosa = randomUUID();
  await pasajeroVerificado(curiosa);
  const res = await app.inject({
    method: 'GET', url: '/api/seguimiento/estonoesuntokendeverdad', headers: cabeceras(curiosa),
  });
  assert.equal(res.statusCode, 404);
});
