// Pruebas de «volver a entrar con el teléfono» (migración 078).
// Requiere la base de desarrollo arrancada y migrada.
//
// Ejecutar: npm run probar
//
// Lo que de verdad se comprueba aquí no es que el camino feliz funcione —eso es
// lo fácil— sino las cuatro cosas que, si se rompieran, convertirían esto en una
// forma de quedarse con la cuenta de otro: que sin código no se entra, que un
// código fallado no deja intentarlo mil veces, que no se puede preguntar por
// números a puñados, y que recuperar la cuenta NO libra de un bloqueo.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { EmisorRegistro } from '../dominio/eventos.js';
import { ServicioVerificacionRegistro } from '../dominio/verificacion-telefono.js';
import { emitirVale } from '../dominio/vales.js';
import { ConexionesSse } from '../eventos/adaptador-sse.js';
import { crearServidor } from './servidor.js';

// Como en el resto de la batería: la base de desarrollo la comparten todas, y
// el teléfono del conductor es UNIQUE.
let siguienteTelefono = Number(
  BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 12)}`) % 100_000_000n,
);
function telefonoUnico(): string {
  siguienteTelefono = (siguienteTelefono + 1) % 100_000_000;
  return `+2406${String(siguienteTelefono).padStart(8, '0')}`;
}

let pool: pg.Pool;
let app: FastifyInstance;
let servicioVerificacion: ServicioVerificacionRegistro;

before(async () => {
  pool = crearPool();
  servicioVerificacion = new ServicioVerificacionRegistro();
  app = crearServidor(pool, new EmisorRegistro(), new ConexionesSse(), servicioVerificacion);
});

after(async () => {
  await app.close();
  await pool.end();
});

async function llamar(
  metodo: 'GET' | 'POST' | 'PUT',
  ruta: string,
  uuid: string,
  cuerpo?: unknown,
): Promise<{ status: number; cuerpo: any }> {
  const res = await app.inject({
    method: metodo,
    url: ruta,
    headers: metodo === 'GET'
      ? { 'x-dispositivo': uuid }
      : { 'x-dispositivo': uuid, 'content-type': 'application/json' },
    ...(metodo === 'GET' ? {} : { payload: (cuerpo ?? {}) as Record<string, unknown> }),
  });
  return { status: res.statusCode, cuerpo: res.json() };
}

async function darDeAltaPasajero(telefono: string, extras: object = {}): Promise<string> {
  const uuid = randomUUID();
  const res = await llamar('PUT', '/api/perfil', uuid, { telefono, ...extras });
  assert.equal(res.status, 200, JSON.stringify(res.cuerpo));
  return uuid;
}

async function darDeAltaConductor(telefono: string, matricula: string): Promise<string> {
  const uuid = randomUUID();
  const res = await llamar('POST', '/api/conductor/alta', uuid, {
    nombre: 'Taxista de prueba', telefono, matricula, marca: 'Toyota', carroceria: 'turismo',
  });
  assert.equal(res.status, 200, JSON.stringify(res.cuerpo));
  return uuid;
}

// Los tres pasos seguidos, que es lo que hace la aplicación.
async function recuperar(
  uuid: string, telefono: string, rol: 'conductor' | 'cliente',
): Promise<{ status: number; cuerpo: any }> {
  const codigo = await llamar('POST', '/api/cuenta/codigo', uuid, { telefono });
  assert.equal(codigo.status, 200, JSON.stringify(codigo.cuerpo));
  return llamar('POST', '/api/cuenta/reclamar', uuid, {
    telefono, rol, codigo: servicioVerificacion.ultimoCodigoPara(telefono),
  });
}

// --- Cuando el SMS no llega (migración 081) ---------------------------------
//
// El 05/10 esto dejó de ser hipotético: Twilio mandaba los códigos y GETESA
// (Orange) los devolvía como «undelivered 30008», así que un taxista verificado
// no podía entrar en su propia cuenta. Las dos salidas se prueban aquí.

test('pedir el código por llamada lo manda por voz, no por SMS', async () => {
  const telefono = telefonoUnico();
  await darDeAltaPasajero(telefono);

  const res = await llamar('POST', '/api/cuenta/codigo', randomUUID(), {
    telefono, canal: 'llamada',
  });
  assert.equal(res.status, 200, JSON.stringify(res.cuerpo));
  assert.equal(res.cuerpo.canal, 'llamada');
  const ultimo = servicioVerificacion.canales.at(-1);
  assert.deepEqual(ultimo, { telefono, canal: 'llamada' });
});

test('sin pedir nada, el código sigue yendo por SMS', async () => {
  const telefono = telefonoUnico();
  await darDeAltaPasajero(telefono);
  const res = await llamar('POST', '/api/cuenta/codigo', randomUUID(), { telefono });
  assert.equal(res.cuerpo.canal, 'sms');
  assert.deepEqual(servicioVerificacion.canales.at(-1), { telefono, canal: 'sms' });
});

// El vale vale EN LUGAR del código, en la misma pantalla y sin que la persona
// tenga que ir a ningún sitio nuevo. Y se gasta: lo que abre una vez no puede
// seguir abriendo, porque un código dictado por teléfono lo oye quien esté
// delante.
test('un vale del operador entra en lugar del código, y solo una vez', async () => {
  const telefono = telefonoUnico();
  await darDeAltaPasajero(telefono);
  const vale = await enTransaccion(pool, (c) => emitirVale(c, telefono, '+240222410986'));

  const uuid = randomUUID();
  const entrada = await llamar('POST', '/api/cuenta/reclamar', uuid, {
    telefono, rol: 'cliente', codigo: vale.codigo,
  });
  assert.equal(entrada.status, 200, JSON.stringify(entrada.cuerpo));
  assert.equal(entrada.cuerpo.rol, 'cliente');

  // Queda escrito qué aparato lo gastó: es lo que separa una excepción de un
  // agujero.
  const fila = await pool.query(
    'SELECT usado_por, emitido_por FROM vale_de_acceso WHERE telefono = $1',
    [telefono],
  );
  assert.equal(fila.rows[0].usado_por, uuid);
  assert.equal(fila.rows[0].emitido_por, '+240222410986');

  const otraVez = await llamar('POST', '/api/cuenta/reclamar', randomUUID(), {
    telefono, rol: 'cliente', codigo: vale.codigo,
  });
  assert.equal(otraVez.status, 400, 'un vale gastado no vuelve a abrir');
});

test('un vale caducado no entra', async () => {
  const telefono = telefonoUnico();
  await darDeAltaPasajero(telefono);
  const vale = await enTransaccion(pool, (c) => emitirVale(c, telefono, 'entorno'));
  await pool.query(
    `UPDATE vale_de_acceso SET caduca_en = now() - interval '1 minute' WHERE telefono = $1`,
    [telefono],
  );
  const res = await llamar('POST', '/api/cuenta/reclamar', randomUUID(), {
    telefono, rol: 'cliente', codigo: vale.codigo,
  });
  assert.equal(res.status, 400);
});

// Dar un vale nuevo tiene que dejar MUERTO al anterior. Si no, cada llamada del
// taxista al operador dejaría otra llave suelta por ahí.
test('el vale nuevo anula el anterior', async () => {
  const telefono = telefonoUnico();
  await darDeAltaPasajero(telefono);
  const viejo = await enTransaccion(pool, (c) => emitirVale(c, telefono, 'entorno'));
  const nuevo = await enTransaccion(pool, (c) => emitirVale(c, telefono, 'entorno'));

  const conElViejo = await llamar('POST', '/api/cuenta/reclamar', randomUUID(), {
    telefono, rol: 'cliente', codigo: viejo.codigo,
  });
  assert.equal(conElViejo.status, 400);
  const conElNuevo = await llamar('POST', '/api/cuenta/reclamar', randomUUID(), {
    telefono, rol: 'cliente', codigo: nuevo.codigo,
  });
  assert.equal(conElNuevo.status, 200, JSON.stringify(conElNuevo.cuerpo));
});

// El vale es para UN número. Que abra la cuenta de otro sería peor que no
// tenerlo.
test('el vale de un número no abre la cuenta de otro', async () => {
  const suyo = telefonoUnico();
  const ajeno = telefonoUnico();
  await darDeAltaPasajero(suyo);
  await darDeAltaPasajero(ajeno);
  const vale = await enTransaccion(pool, (c) => emitirVale(c, suyo, 'entorno'));

  const res = await llamar('POST', '/api/cuenta/reclamar', randomUUID(), {
    telefono: ajeno, rol: 'cliente', codigo: vale.codigo,
  });
  assert.equal(res.status, 400);
});

test('un número desconocido no está registrado, y la respuesta trae la forma canónica', async () => {
  const res = await llamar('POST', '/api/cuenta/buscar', randomUUID(), { telefono: '666112233' });
  assert.equal(res.status, 200, JSON.stringify(res.cuerpo));
  assert.equal(res.cuerpo.conductor, false);
  assert.equal(res.cuerpo.cliente, false);
  // Nueve dígitos se leen como guineanos (migración 024): es lo que hace que
  // quien se registró con prefijo se encuentre escribiéndolo sin él.
  assert.equal(res.cuerpo.telefono, '+240666112233');
});

test('se encuentra al pasajero escribiendo el número sin el prefijo', async () => {
  const telefono = telefonoUnico();
  await darDeAltaPasajero(telefono);
  const sinPrefijo = telefono.replace('+240', '');

  const res = await llamar('POST', '/api/cuenta/buscar', randomUUID(), { telefono: sinPrefijo });
  assert.equal(res.cuerpo.cliente, true);
  assert.equal(res.cuerpo.conductor, false);
  assert.equal(res.cuerpo.telefono, telefono);
});

test('el pasajero vuelve en otro aparato sin dar ningún dato más', async () => {
  const telefono = telefonoUnico();
  await darDeAltaPasajero(telefono, { nombre: 'Lucía', genero: 'mujer' });

  const nuevo = randomUUID();
  const res = await recuperar(nuevo, telefono, 'cliente');
  assert.equal(res.status, 200, JSON.stringify(res.cuerpo));
  assert.equal(res.cuerpo.rol, 'cliente');
  assert.equal(res.cuerpo.nombre, 'Lucía');

  const sesion = await llamar('GET', '/api/sesion', nuevo);
  assert.equal(sesion.cuerpo.rol, 'cliente');
  assert.equal(sesion.cuerpo.cliente.telefono, telefono);
  // Lo que significa «no me lo vuelvas a pedir»: los datos que ya había
  // declarado están en el perfil nuevo sin que nadie los teclease.
  assert.equal(sesion.cuerpo.cliente.nombre, 'Lucía');
  assert.equal(sesion.cuerpo.cliente.genero, 'mujer');
  // El SMS acaba de llegar a ese número, así que entra directo al panel sin
  // pasar otra vez por la pantalla de confirmar.
  assert.equal(sesion.cuerpo.cliente.telefonoVerificado, true);
});

test('el taxista vuelve con su ficha entera y sin volver a dar la matrícula', async () => {
  const telefono = telefonoUnico();
  const matricula = `MB-${String(siguienteTelefono).slice(-5)}X`;
  await darDeAltaConductor(telefono, matricula);

  const nuevo = randomUUID();
  const res = await recuperar(nuevo, telefono, 'conductor');
  assert.equal(res.status, 200, JSON.stringify(res.cuerpo));
  assert.equal(res.cuerpo.rol, 'conductor');
  assert.equal(res.cuerpo.nombre, 'Taxista de prueba');

  const sesion = await llamar('GET', '/api/sesion', nuevo);
  assert.equal(sesion.cuerpo.rol, 'conductor');
  assert.equal(sesion.cuerpo.conductor.matricula, matricula);
  assert.equal(sesion.cuerpo.conductor.telefonoVerificado, true);
});

test('sin el código no se entra: el aparato nuevo sigue sin cuenta', async () => {
  const telefono = telefonoUnico();
  await darDeAltaPasajero(telefono);

  const nuevo = randomUUID();
  await llamar('POST', '/api/cuenta/codigo', nuevo, { telefono });
  const res = await llamar('POST', '/api/cuenta/reclamar', nuevo, {
    telefono, rol: 'cliente', codigo: '000000',
  });
  assert.equal(res.status, 400, JSON.stringify(res.cuerpo));

  const sesion = await llamar('GET', '/api/sesion', nuevo);
  assert.equal(sesion.cuerpo.rol, null);
});

test('recuperar la cuenta no libra del bloqueo', async () => {
  const telefono = telefonoUnico();
  const viejo = await darDeAltaPasajero(telefono);
  await pool.query(
    `UPDATE dispositivo SET strikes = 3, bloqueado_en = now()
     WHERE uuid_persistente = $1`,
    [viejo],
  );

  const nuevo = randomUUID();
  const res = await recuperar(nuevo, telefono, 'cliente');
  assert.equal(res.status, 200, JSON.stringify(res.cuerpo));

  // Era la puerta de atrás: borrar los datos del navegador para empezar limpio.
  const sesion = await llamar('GET', '/api/sesion', nuevo);
  assert.equal(sesion.cuerpo.cliente.bloqueado, true);
});

test('pedir el papel equivocado da 404, no la cuenta del otro papel', async () => {
  const telefono = telefonoUnico();
  await darDeAltaPasajero(telefono);

  const nuevo = randomUUID();
  const res = await recuperar(nuevo, telefono, 'conductor');
  assert.equal(res.status, 404, JSON.stringify(res.cuerpo));
});

test('no se manda ningún SMS a un número que no está registrado', async () => {
  const telefono = telefonoUnico();
  const res = await llamar('POST', '/api/cuenta/codigo', randomUUID(), { telefono });
  assert.equal(res.status, 404);
  assert.ok(!servicioVerificacion.enviados.includes(telefono));
});

test('dos códigos seguidos al mismo número: el segundo da 429', async () => {
  const telefono = telefonoUnico();
  await darDeAltaPasajero(telefono);
  const uuid = randomUUID();

  assert.equal((await llamar('POST', '/api/cuenta/codigo', uuid, { telefono })).status, 200);
  const segundo = await llamar('POST', '/api/cuenta/codigo', uuid, { telefono });
  assert.equal(segundo.status, 429, JSON.stringify(segundo.cuerpo));
});

test('a los cinco códigos fallados se cierra la recuperación de ese número', async () => {
  const telefono = telefonoUnico();
  await darDeAltaPasajero(telefono);
  const uuid = randomUUID();
  await llamar('POST', '/api/cuenta/codigo', uuid, { telefono });

  for (let i = 0; i < 5; i += 1) {
    const fallo = await llamar('POST', '/api/cuenta/reclamar', uuid, {
      telefono, rol: 'cliente', codigo: '000000',
    });
    assert.equal(fallo.status, 400, `intento ${i}: ${JSON.stringify(fallo.cuerpo)}`);
  }

  // El sexto ya no se comprueba: seis cifras se aciertan probando, y lo que se
  // abre probando es la cuenta de otro. Ni siquiera con el código bueno.
  const bueno = await llamar('POST', '/api/cuenta/reclamar', uuid, {
    telefono, rol: 'cliente', codigo: servicioVerificacion.ultimoCodigoPara(telefono),
  });
  assert.equal(bueno.status, 429, JSON.stringify(bueno.cuerpo));
});

test('un mismo aparato no puede disparar SMS a diez números distintos', async () => {
  const uuid = randomUUID();
  // Diez números registrados, que es el caso malo: quien ya los conoce no
  // necesita preguntar por ellos, así que el cupo de consultas no le frena.
  for (let i = 0; i < 10; i += 1) {
    const telefono = telefonoUnico();
    await darDeAltaPasajero(telefono);
    const res = await llamar('POST', '/api/cuenta/codigo', uuid, { telefono });
    assert.equal(res.status, 200, `SMS ${i}: ${JSON.stringify(res.cuerpo)}`);
  }
  const otro = telefonoUnico();
  await darDeAltaPasajero(otro);
  const once = await llamar('POST', '/api/cuenta/codigo', uuid, { telefono: otro });
  assert.equal(once.status, 429, JSON.stringify(once.cuerpo));
  assert.ok(!servicioVerificacion.enviados.includes(otro));
});

test('preguntar por diez números distintos agota el cupo de la hora', async () => {
  // Un aparato recién instalado: el contador empieza a cero.
  const uuid = randomUUID();
  for (let i = 0; i < 10; i += 1) {
    const res = await llamar('POST', '/api/cuenta/buscar', uuid, { telefono: telefonoUnico() });
    assert.equal(res.status, 200, `consulta ${i}: ${JSON.stringify(res.cuerpo)}`);
  }
  const once = await llamar('POST', '/api/cuenta/buscar', uuid, { telefono: telefonoUnico() });
  assert.equal(once.status, 429, JSON.stringify(once.cuerpo));
});

test('repetir el MISMO número no gasta cupo: equivocarse al teclear es normal', async () => {
  const uuid = randomUUID();
  const telefono = telefonoUnico();
  for (let i = 0; i < 12; i += 1) {
    const res = await llamar('POST', '/api/cuenta/buscar', uuid, { telefono });
    assert.equal(res.status, 200, `consulta ${i}: ${JSON.stringify(res.cuerpo)}`);
  }
});
