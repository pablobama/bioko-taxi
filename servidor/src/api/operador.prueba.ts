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
import { ServicioVerificacionRegistro } from '../dominio/verificacion-telefono.js';
import { crearZona, guardarReferencia } from '../dominio/gazetteer.js';
import { indiceDeNumero, numeroDeIndice } from '../dominio/numeros-taxi.js';
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
// Un DIP de nueve dígitos que no se repite dentro de la ejecución.
let siguienteDip = Math.floor(Math.random() * 900_000_000) + 100_000_000;
function dipUnico(): string {
  siguienteDip = siguienteDip >= 999_999_999 ? 100_000_000 : siguienteDip + 1;
  return String(siguienteDip);
}

let pool: pg.Pool;
let app: FastifyInstance;
let servicioVerificacion: ServicioVerificacionRegistro;

before(async () => {
  // La lista de operadores llega por entorno; para las pruebas se inyecta
  // antes de crear el servidor, igual que hará Render en producción.
  process.env.UUIDS_OPERADOR = `${UUID_OPERADOR}, otro-texto-que-se-ignora`;
  // La raíz por teléfono (migración 080). Como los uuids: llega por entorno y
  // se inyecta antes de crear el servidor, igual que hará Render.
  process.env.TELEFONOS_OPERADOR = '222410986';
  pool = crearPool();
  servicioVerificacion = new ServicioVerificacionRegistro();
  app = crearServidor(pool, new EmisorRegistro(), new ConexionesSse(), servicioVerificacion);
});

after(async () => {
  delete process.env.UUIDS_OPERADOR;
  delete process.env.TELEFONOS_OPERADOR;
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

// --- Entrar con el teléfono (migración 080) ---------------------------------
//
// Lo que se comprueba no es que el camino feliz funcione, sino las tres cosas
// que lo convertirían en una puerta abierta: que sin código no se entra, que un
// número que NO está en la lista no entra ni aunque acierte un código, y que la
// puerta no sirve para averiguar quién manda en la plataforma.

test('entrar como operador: el teléfono de la raíz, con su código, abre el panel', async () => {
  const telefonoRaiz = raizNueva();
  const nuevo = randomUUID();

  // Antes de nada, no es nadie.
  const antes = await app.inject({
    method: 'GET', url: '/api/operador/estadisticas', headers: cabeceras(nuevo),
  });
  assert.equal(antes.statusCode, 403);

  const pedido = await app.inject({
    method: 'POST', url: '/api/operador/entrar/codigo', headers: cabeceras(nuevo),
    payload: { telefono: telefonoRaiz },
  });
  assert.equal(pedido.statusCode, 200, pedido.body);
  assert.ok(servicioVerificacion.enviados.includes(telefonoRaiz));

  const codigo = servicioVerificacion.ultimoCodigoPara(telefonoRaiz);
  const entrada = await app.inject({
    method: 'POST', url: '/api/operador/entrar', headers: cabeceras(nuevo),
    payload: { telefono: telefonoRaiz, codigo },
  });
  assert.equal(entrada.statusCode, 200, entrada.body);
  assert.equal(entrada.json().raiz, true);

  // Y ahora sí: la sesión lo dice y las rutas del panel le dejan pasar.
  const sesion = await app.inject({
    method: 'GET', url: '/api/sesion', headers: { 'x-dispositivo': nuevo },
  });
  assert.equal(sesion.json().rol, 'operador');
  const despues = await app.inject({
    method: 'GET', url: '/api/operador/estadisticas', headers: cabeceras(nuevo),
  });
  assert.equal(despues.statusCode, 200);
});

test('entrar como operador: con el código mal no se entra', async () => {
  const telefonoRaiz = raizNueva();
  const nuevo = randomUUID();
  await app.inject({
    method: 'POST', url: '/api/operador/entrar/codigo', headers: cabeceras(nuevo),
    payload: { telefono: telefonoRaiz },
  });
  const entrada = await app.inject({
    method: 'POST', url: '/api/operador/entrar', headers: cabeceras(nuevo),
    payload: { telefono: telefonoRaiz, codigo: '000000' },
  });
  assert.equal(entrada.statusCode, 400);
  const sesion = await app.inject({
    method: 'GET', url: '/api/sesion', headers: { 'x-dispositivo': nuevo },
  });
  assert.notEqual(sesion.json().rol, 'operador');
});

// La puerta NO puede servir para averiguar quién manda. Se contesta lo mismo a
// un número de la casa y a uno de la calle; lo único que cambia es que al de la
// calle no le llega ningún SMS. Si esto se rompiera, cualquiera podría ir
// probando números hasta dar con el del operador — y ya sabría a quién
// buscarle el teléfono.
test('entrar como operador: un número de fuera recibe la misma respuesta y ningún SMS', async () => {
  const nuevo = randomUUID();
  const ajeno = telefonoUnico();
  const pedido = await app.inject({
    method: 'POST', url: '/api/operador/entrar/codigo', headers: cabeceras(nuevo),
    payload: { telefono: ajeno },
  });
  assert.equal(pedido.statusCode, 200, 'la respuesta no puede delatar quién es operador');
  assert.deepEqual(pedido.json(), { enviado: true });
  assert.ok(!servicioVerificacion.enviados.includes(ajeno), 'no se le manda nada');

  // Y aunque acertara un código —que no lo tiene— tampoco entraría.
  const entrada = await app.inject({
    method: 'POST', url: '/api/operador/entrar', headers: cabeceras(nuevo),
    payload: { telefono: ajeno, codigo: '123456' },
  });
  assert.equal(entrada.statusCode, 400);
});

// Una raíz recién estrenada, y hace falta que sea recién estrenada: el cooldown
// de un minuto entre códigos vive en la BASE de desarrollo, que no se vacía
// entre ejecuciones. Repetir la batería dentro del mismo minuto dejaba al
// teléfono de siempre sin código —no se le manda, por diseño— y la prueba
// fallaba por algo que no tenía nada que ver con lo que comprobaba.
//
// `TELEFONOS_OPERADOR` se lee en cada llamada a propósito (migración 080), así
// que añadir un número aquí basta y no hace falta rehacer el servidor.
function raizNueva(): string {
  const telefono = telefonoUnico();
  process.env.TELEFONOS_OPERADOR = `${process.env.TELEFONOS_OPERADOR ?? ''},${telefono}`;
  return telefono;
}

// Entra como operador desde un aparato nuevo y devuelve su uuid. El código no
// se consume en el doble de pruebas, así que volver a entrar con el mismo
// teléfono funciona aunque el cooldown de un minuto impida mandar otro SMS.
async function entrarComoOperador(telefono: string): Promise<string> {
  const uuid = randomUUID();
  await app.inject({
    method: 'POST', url: '/api/operador/entrar/codigo', headers: cabeceras(uuid),
    payload: { telefono },
  });
  const codigo = servicioVerificacion.ultimoCodigoPara(telefono);
  const entrada = await app.inject({
    method: 'POST', url: '/api/operador/entrar', headers: cabeceras(uuid),
    payload: { telefono, codigo },
  });
  assert.equal(entrada.statusCode, 200, entrada.body);
  return uuid;
}

// Dar y quitar accesos (migración 080). Lo que de verdad se comprueba aquí no
// es que la lista crezca —eso es un INSERT— sino las DOS cosas que hacen que
// este mecanismo signifique algo:
//
//   · que un operador normal no pueda repartir accesos. Si pudiera, echarle no
//     serviría de nada: antes de salir se nombraría a sí mismo con otro número.
//   · que al echar a alguien se le caigan los aparatos EN EL ACTO. Dejarlos
//     vivos un rato más es dejarle entrar después de haberle echado, que es
//     justo lo que no puede pasar cuando se revoca a alguien con prisa.
test('accesos: la raíz da y quita, un operador normal solo mira', async () => {
  const telefonoRaiz = raizNueva();
  const raiz = await entrarComoOperador(telefonoRaiz);
  const suyo = telefonoUnico();

  const alta = await app.inject({
    method: 'POST', url: '/api/operador/accesos', headers: cabeceras(raiz),
    payload: { telefono: suyo, nombre: 'Marta del turno de noche' },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  assert.equal(alta.json().yaEstaba, false);

  // Repetir el alta no es un error, pero se dice que ya estaba: quien pulsa
  // tiene que saber si hizo algo o se equivocó de número.
  const otraVez = await app.inject({
    method: 'POST', url: '/api/operador/accesos', headers: cabeceras(raiz),
    payload: { telefono: suyo },
  });
  assert.equal(otraVez.json().yaEstaba, true);

  // Y ya puede entrar con su teléfono.
  const ella = await entrarComoOperador(suyo);
  const panel = await app.inject({
    method: 'GET', url: '/api/operador/estadisticas', headers: cabeceras(ella),
  });
  assert.equal(panel.statusCode, 200);

  // Ve la lista, con la raíz marcada y ella misma dentro...
  const lista = await app.inject({
    method: 'GET', url: '/api/operador/accesos', headers: cabeceras(ella),
  });
  assert.equal(lista.statusCode, 200, lista.body);
  assert.deepEqual(lista.json().yo, { telefono: suyo, raiz: false });
  const filas = lista.json().operadores as Array<{ telefono: string; raiz: boolean; nombre: string | null }>;
  assert.ok(filas.some((f) => f.telefono === telefonoRaiz && f.raiz === true));
  const mia = filas.find((f) => f.telefono === suyo);
  assert.equal(mia?.nombre, 'Marta del turno de noche');
  assert.equal(mia?.raiz, false);

  // ...pero no la toca.
  const intento = await app.inject({
    method: 'POST', url: '/api/operador/accesos', headers: cabeceras(ella),
    payload: { telefono: telefonoUnico() },
  });
  assert.equal(intento.statusCode, 403, 'un operador normal no reparte accesos');
  const intentoQuitar = await app.inject({
    method: 'POST', url: '/api/operador/accesos/quitar', headers: cabeceras(ella),
    payload: { telefono: telefonoRaiz },
  });
  assert.equal(intentoQuitar.statusCode, 403);

  // La raíz la echa, y su aparato deja de valer en la misma respuesta.
  const baja = await app.inject({
    method: 'POST', url: '/api/operador/accesos/quitar', headers: cabeceras(raiz),
    payload: { telefono: suyo },
  });
  assert.equal(baja.statusCode, 200, baja.body);
  const despues = await app.inject({
    method: 'GET', url: '/api/operador/estadisticas', headers: cabeceras(ella),
  });
  assert.equal(despues.statusCode, 403, 'echar a alguien le echa también los aparatos');

  // Y volver a entrar con su teléfono tampoco vale: el código es correcto, pero
  // ya no está en la lista.
  const reintento = await app.inject({
    method: 'POST', url: '/api/operador/entrar', headers: cabeceras(randomUUID()),
    payload: { telefono: suyo, codigo: servicioVerificacion.ultimoCodigoPara(suyo) },
  });
  assert.equal(reintento.statusCode, 400);

  // Quitarla dos veces es un 404 y no un «hecho» en falso.
  const otraBaja = await app.inject({
    method: 'POST', url: '/api/operador/accesos/quitar', headers: cabeceras(raiz),
    payload: { telefono: suyo },
  });
  assert.equal(otraBaja.statusCode, 404);
});

// A la raíz no se la echa desde el panel. Es el seguro contra quedarse todos
// fuera: si el permiso de todos viviera en la base, una revocación con prisa
// podría dejar la plataforma sin ningún operador y sin forma de volver a
// entrar. Y darla de alta tampoco: sería una fila que no hace nada y que al
// revocarla daría la falsa sensación de haberla echado.
test('accesos: a la raíz no se la echa ni se la da de alta desde el panel', async () => {
  const telefonoRaiz = raizNueva();
  const raiz = await entrarComoOperador(telefonoRaiz);

  const baja = await app.inject({
    method: 'POST', url: '/api/operador/accesos/quitar', headers: cabeceras(raiz),
    payload: { telefono: telefonoRaiz },
  });
  assert.equal(baja.statusCode, 409, baja.body);

  const alta = await app.inject({
    method: 'POST', url: '/api/operador/accesos', headers: cabeceras(raiz),
    payload: { telefono: telefonoRaiz },
  });
  assert.equal(alta.statusCode, 409, alta.body);

  // Sigue entrando, por supuesto.
  const panel = await app.inject({
    method: 'GET', url: '/api/operador/estadisticas', headers: cabeceras(raiz),
  });
  assert.equal(panel.statusCode, 200);
});

// El móvil que se perdió. Se echa el APARATO y la persona sigue siendo
// operadora: entra desde los demás, y desde ése tendrá que volver a pedir el
// código.
test('accesos: echar un aparato deja a la persona dentro y al aparato fuera', async () => {
  const raiz = await entrarComoOperador(raizNueva());
  const suyo = telefonoUnico();
  await app.inject({
    method: 'POST', url: '/api/operador/accesos', headers: cabeceras(raiz),
    payload: { telefono: suyo },
  });
  const perdido = await entrarComoOperador(suyo);

  const aparatos = await app.inject({
    method: 'POST', url: '/api/operador/accesos/aparatos', headers: cabeceras(raiz),
    payload: { telefono: suyo },
  });
  assert.equal(aparatos.statusCode, 200, aparatos.body);
  const uuids = (aparatos.json().aparatos as Array<{ uuid: string }>).map((a) => a.uuid);
  assert.deepEqual(uuids, [perdido]);

  const echar = await app.inject({
    method: 'POST', url: '/api/operador/accesos/aparatos/quitar', headers: cabeceras(raiz),
    payload: { uuid: perdido },
  });
  assert.equal(echar.statusCode, 200, echar.body);

  const desdeElPerdido = await app.inject({
    method: 'GET', url: '/api/operador/estadisticas', headers: cabeceras(perdido),
  });
  assert.equal(desdeElPerdido.statusCode, 403);

  // La persona no ha perdido el acceso: desde otro aparato entra igual.
  const otro = await entrarComoOperador(suyo);
  const panel = await app.inject({
    method: 'GET', url: '/api/operador/estadisticas', headers: cabeceras(otro),
  });
  assert.equal(panel.statusCode, 200);
});

// El vale lo da CUALQUIER operador, no solo la raíz: el taxista llama porque no
// puede entrar, y eso pasa a cualquier hora del turno. Lo que lo sujeta es que
// dura minutos, se gasta una vez, es de un solo número y queda firmado.
test('vale: lo da cualquier operador, firmado, y no para un número sin cuenta', async () => {
  const raiz = await entrarComoOperador(raizNueva());
  const telefono = telefonoUnico();

  // Para un número que no existe no se da nada: dictar un código que no abre
  // nada es dejar a la persona esperando al otro lado del teléfono.
  const enElAire = await app.inject({
    method: 'POST', url: '/api/operador/vale', headers: cabeceras(raiz),
    payload: { telefono },
  });
  assert.equal(enElAire.statusCode, 404, enElAire.body);

  // Con un taxista de verdad sí.
  const alta = await app.inject({
    method: 'POST', url: '/api/conductor/alta', headers: cabeceras(randomUUID()),
    payload: {
      nombre: 'Taxista sin SMS', telefono, matricula: `M-${randomUUID().slice(0, 6)}`,
      marca: 'Toyota', carroceria: 'turismo',
    },
  });
  assert.equal(alta.statusCode, 200, alta.body);

  const vale = await app.inject({
    method: 'POST', url: '/api/operador/vale', headers: cabeceras(raiz),
    payload: { telefono },
  });
  assert.equal(vale.statusCode, 200, vale.body);
  assert.match(vale.json().codigo, /^\d{6}$/);

  const fila = await pool.query(
    'SELECT emitido_por FROM vale_de_acceso WHERE telefono = $1 AND usado_en IS NULL',
    [telefono],
  );
  assert.equal(fila.rowCount, 1, 'el vale queda guardado y firmado');

  // Y un aparato que no es de operador no reparte vales.
  const intruso = await app.inject({
    method: 'POST', url: '/api/operador/vale', headers: cabeceras(randomUUID()),
    payload: { telefono },
  });
  assert.equal(intruso.statusCode, 403);
});

// Cambiar el número de alguien (05/10). El teléfono es la IDENTIDAD, no un dato
// de contacto: lo que se comprueba aquí es que después se entra con el nuevo,
// que el viejo deja de servir, que no se le puede dar el de otro, y que el
// nuevo queda SIN verificar —de esa línea no ha demostrado nada nadie todavía—.
test('el operador cambia el número de un taxista: entra con el nuevo y no con el viejo', async () => {
  const raiz = await entrarComoOperador(raizNueva());
  const viejo = telefonoUnico();
  const nuevo = telefonoUnico();
  const alta = await app.inject({
    method: 'POST', url: '/api/conductor/alta', headers: cabeceras(randomUUID()),
    payload: {
      nombre: 'Taxista que cambia de línea', telefono: viejo,
      matricula: `M-${randomUUID().slice(0, 6)}`, marca: 'Toyota', carroceria: 'turismo',
    },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  const conductorId = Number(alta.json().conductorId);
  await pool.query(
    `UPDATE conductor SET estado_verificacion = 'verificado',
     telefono_verificado_en = now() WHERE id = $1`,
    [conductorId],
  );

  const cambio = await app.inject({
    method: 'POST', url: `/api/operador/conductores/${conductorId}/telefono`,
    headers: cabeceras(raiz), payload: { telefono: nuevo },
  });
  assert.equal(cambio.statusCode, 200, cambio.body);
  assert.equal(cambio.json().telefono, nuevo);
  assert.equal(cambio.json().antes, viejo);

  const fila = await pool.query(
    'SELECT telefono, telefono_verificado_en FROM conductor WHERE id = $1',
    [conductorId],
  );
  assert.equal(fila.rows[0].telefono, nuevo);
  assert.equal(
    fila.rows[0].telefono_verificado_en, null,
    'de la línea nueva no ha demostrado nada nadie: no hereda la verificación',
  );

  // Con el nuevo entra en la app de taxi; con el viejo ya no existe.
  const conElNuevo = await app.inject({
    method: 'POST', url: '/api/conductor/registro', headers: cabeceras(randomUUID()),
    payload: { telefono: nuevo },
  });
  assert.equal(conElNuevo.statusCode, 200, conElNuevo.body);
  const conElViejo = await app.inject({
    method: 'POST', url: '/api/conductor/registro', headers: cabeceras(randomUUID()),
    payload: { telefono: viejo },
  });
  assert.equal(conElViejo.statusCode, 404);

  // Y queda escrito quién lo hizo (migración 067).
  const registro = await pool.query(
    `SELECT valor_anterior, valor_nuevo, es_operador FROM cambio_ajuste
     WHERE ambito = 'conductor' AND clave = $1`,
    [`${conductorId}.telefono`],
  );
  assert.equal(registro.rowCount, 1);
  assert.equal(registro.rows[0].valor_anterior, viejo);
  assert.equal(registro.rows[0].valor_nuevo, nuevo);
});

test('no se le puede dar a alguien el número de otro', async () => {
  const raiz = await entrarComoOperador(raizNueva());
  const unos = telefonoUnico();
  const otros = telefonoUnico();
  const altas = [];
  for (const telefono of [unos, otros]) {
    const res = await app.inject({
      method: 'POST', url: '/api/conductor/alta', headers: cabeceras(randomUUID()),
      payload: {
        nombre: `Taxista ${telefono}`, telefono,
        matricula: `M-${randomUUID().slice(0, 6)}`, marca: 'Toyota', carroceria: 'turismo',
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    altas.push(Number(res.json().conductorId));
  }

  const choque = await app.inject({
    method: 'POST', url: `/api/operador/conductores/${altas[0]}/telefono`,
    headers: cabeceras(raiz), payload: { telefono: otros },
  });
  assert.equal(choque.statusCode, 409, choque.body);
  assert.match(choque.json().error, /ya es de/);

  // Y el primero sigue con el suyo: un cambio rechazado no deja nada a medias.
  const fila = await pool.query('SELECT telefono FROM conductor WHERE id = $1', [altas[0]]);
  assert.equal(fila.rows[0].telefono, unos);
});

test('operador: sin el uuid en la lista, 403 en todas las rutas', async () => {
  const intruso = randomUUID();
  for (const url of ['/api/operador/estadisticas', '/api/operador/incidencias', '/api/operador/pasajeros', '/api/operador/vivo']) {
    const res = await app.inject({ method: 'GET', url, headers: cabeceras(intruso) });
    assert.equal(res.statusCode, 403, `${url} debería negarse`);
  }
});

// La consola de despacho (03/10). Lo que se comprueba no es que devuelva una
// lista —eso es casi gratis— sino que NO cuente como «en servicio» a un taxi
// cuyo último latido es de hace horas. Esa fila existe de verdad en la tabla:
// quien apaga la presencia es un reloj que puede llevar parado un rato, y sin
// el filtro la consola manda al operador a llamar a alguien que apagó el móvil
// ayer, que es peor que no enseñarle nada.
test('vivo: un taxi con el latido viejo no sale como en servicio', async () => {
  const telefono = telefonoUnico();
  const alta = await app.inject({
    method: 'POST', url: '/api/conductor/alta', headers: cabeceras(randomUUID()),
    payload: {
      nombre: 'Taxista fantasma', telefono,
      matricula: `MB-${telefono.slice(-5)}F`, marca: 'Toyota', carroceria: 'turismo',
    },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  // Con Number() a propósito: el alta devuelve el id tal como lo serializa
  // Postgres, que para un bigint es TEXTO. Comparar eso con el número que da
  // /vivo sale siempre falso, y la prueba pasaría sin comprobar nada.
  const conductorId = Number(alta.json().conductorId);

  // En servicio según la tabla, pero sin dar señales desde hace dos horas.
  await pool.query(
    `UPDATE presencia SET estado = 'DISPONIBLE', ultimo_heartbeat = now() - interval '2 hours'
     WHERE conductor_id = $1`,
    [conductorId],
  );
  await pool.query(
    'INSERT INTO rastro (conductor_id, lat, lng) VALUES ($1, 3.752, 8.779)',
    [conductorId],
  );

  const viejo = await app.inject({
    method: 'GET', url: '/api/operador/vivo', headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(viejo.statusCode, 200, viejo.body);
  assert.ok(
    !viejo.json().taxis.some((t: { conductor_id: number }) => t.conductor_id === conductorId),
    'un taxi sin latido reciente no se despacha',
  );

  // Con el latido fresco sí, y con la posición que acaba de mandar.
  await pool.query(
    "UPDATE presencia SET ultimo_heartbeat = now() WHERE conductor_id = $1",
    [conductorId],
  );
  const ahora = await app.inject({
    method: 'GET', url: '/api/operador/vivo', headers: cabeceras(UUID_OPERADOR),
  });
  const suyo = ahora.json().taxis
    .find((t: { conductor_id: number }) => t.conductor_id === conductorId);
  assert.ok(suyo, 'con el latido fresco tiene que salir');
  assert.equal(suyo.lat, 3.752);
  assert.equal(suyo.estado, 'DISPONIBLE');
  // El id llega como número y no como texto: el bigint de Postgres se serializa
  // como cadena si no se le pide otra cosa, y entonces el mapa no encuentra el
  // taxi al cruzarlo con la lista.
  assert.equal(typeof suyo.conductor_id, 'number');
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

// Un taxista listo para trabajar: verificado, suscrito, con el latido fresco
// y plantado en la zona que se le diga. Lo que las oleadas exigen de verdad.
async function taxistaListo(zonaId: number): Promise<number> {
  const telefono = telefonoUnico();
  const alta = await app.inject({
    method: 'POST', url: '/api/conductor/alta', headers: cabeceras(randomUUID()),
    payload: {
      nombre: `Taxista listo ${telefono.slice(-4)}`, telefono,
      matricula: `MB-${telefono.slice(-5)}D`, marca: 'Toyota', carroceria: 'turismo',
    },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  const conductorId = Number(alta.json().conductorId);
  await pool.query(
    `UPDATE conductor SET estado_verificacion = 'verificado',
            telefono_verificado_en = now(),
            suscrito_hasta = now() + interval '30 days'
     WHERE id = $1`,
    [conductorId],
  );
  await pool.query(
    `UPDATE presencia SET estado = 'DISPONIBLE', ultimo_heartbeat = now(), zona_id = $2
     WHERE conductor_id = $1`,
    [conductorId, zonaId],
  );
  return conductorId;
}

// La oferta dirigida (06/10). Lo que se comprueba no es que inserte una fila:
// es que la mesa salta la GEOGRAFÍA y no la seguridad. El taxi de otra zona
// —que ninguna oleada habría convocado todavía— recibe la oferta con la firma
// del operador; y el que ya la tiene delante no la recibe dos veces.
// El alta hecha por el operador (06/10). Las tres cosas que importan: nace
// verificado (lo verificó él), el TELÉFONO queda por confirmar (de esa línea
// no ha demostrado nada nadie), y el aparato del operador NO queda vinculado
// como si fuera el taxi — que es lo que haría el alta normal, pensada para
// que la mande el propio taxista desde su móvil.
// El número de taxi (084). Lo que se comprueba es el contrato entero: la
// secuencia numera CADA alta —la del panel y la del propio taxista—, a mano
// solo se da un número por detrás del último generado y libre, y el que ya
// es de alguien no se toca, porque es para siempre.
test('número de taxi: apagado no reparte; encendido numera, y a mano solo por detrás', async () => {
  function altaDelPanel(extra: Record<string, unknown> = {}) {
    const telefono = telefonoUnico();
    return app.inject({
      method: 'POST', url: '/api/operador/conductores', headers: cabeceras(UUID_OPERADOR),
      payload: {
        nombre: `Numerado ${telefono.slice(-4)}`, apellido: 'Taxi', telefono,
        dip: dipUnico(), duenoConduce: true,
        matricula: `MB-${telefono.slice(-5)}N`, marca: 'Toyota', carroceria: 'turismo',
        ...extra,
      },
    });
  }

  // APAGADO (que es como nace, migración 085): nadie recibe número, y
  // dictarlo a mano avisa de dónde está el interruptor.
  const apagada = await altaDelPanel();
  assert.equal(apagada.statusCode, 200, apagada.body);
  assert.equal(apagada.json().numeroTaxi, null);
  const manualApagada = await altaDelPanel({ numeroTaxi: 'A000' });
  assert.equal(manualApagada.statusCode, 400);
  assert.match(manualApagada.json().error, /apagada/);

  // Encendido, el resto del contrato. Se devuelve a 0 al final: apagado es
  // el estado real de la plataforma mientras el operador no diga otra cosa.
  await pool.query(
    `UPDATE parametro SET valor = '1' WHERE clave = 'numero_taxi_activado'`,
  );
  try {
  const primera = await altaDelPanel();
  assert.equal(primera.statusCode, 200, primera.body);
  const numero1: string = primera.json().numeroTaxi;
  assert.match(numero1, /^[A-Z]{1,2}\d{3}$/);

  const segunda = await altaDelPanel();
  assert.equal(segunda.statusCode, 200, segunda.body);
  const numero2: string = segunda.json().numeroTaxi;
  assert.equal(
    indiceDeNumero(numero2), indiceDeNumero(numero1)! + 1,
    `${numero1} y ${numero2} tendrían que ser consecutivos`,
  );

  // Y el alta del PROPIO taxista también numera: nadie se queda sin número.
  const propia = await app.inject({
    method: 'POST', url: '/api/conductor/alta', headers: cabeceras(randomUUID()),
    payload: {
      nombre: 'Numerado por sí mismo', telefono: telefonoUnico(),
      matricula: `MB-${Date.now() % 100000}S`, marca: 'Kia', carroceria: 'turismo',
    },
  });
  assert.equal(propia.statusCode, 200, propia.body);
  assert.equal(indiceDeNumero(propia.json().numeroTaxi), indiceDeNumero(numero2)! + 1);

  // Lo que no es un número, se rechaza con la forma delante.
  const malaForma = await altaDelPanel({ numeroTaxi: 'TAXI-7' });
  assert.equal(malaForma.statusCode, 400);
  assert.match(malaForma.json().error, /A013/);

  // Por DELANTE de la secuencia, jamás: sería saltar la cola.
  const porDelante = await altaDelPanel({
    numeroTaxi: numeroDeIndice(indiceDeNumero(numero2)! + 500),
  });
  assert.equal(porDelante.statusCode, 400);
  assert.match(porDelante.json().error, /ya emitidos/);

  // El de otro, jamás: es para siempre.
  const ocupado = await altaDelPanel({ numeroTaxi: numero1 });
  assert.equal(ocupado.statusCode, 409);
  assert.match(ocupado.json().error, /para siempre/);

  // Y el caso para el que existe lo manual: un número por detrás y LIBRE —el
  // que un coche lleva pintado—. En la vida real los huecos vienen de flotas
  // numeradas antes de la plataforma; aquí se fabrica uno vaciando el de la
  // primera alta, que es condición de laboratorio y se queda en esta prueba.
  await pool.query(
    'UPDATE conductor SET numero_taxi = NULL WHERE numero_taxi = $1',
    [numero1],
  );
  const pintado = await altaDelPanel({ numeroTaxi: numero1.toLowerCase() });
  assert.equal(pintado.statusCode, 200, pintado.body);
  assert.equal(pintado.json().numeroTaxi, numero1, 'en forma canónica, aunque se teclee en minúsculas');
  } finally {
    await pool.query(
      `UPDATE parametro SET valor = '0' WHERE clave = 'numero_taxi_activado'`,
    );
  }
});

// La radio de la Central (086), de punta a punta: escucha y emite, que es lo
// que el operador pidió con exclamación. Lo que de verdad se comprueba:
//   · el turno es UNO para todos — si la Central habla, el taxista espera, y
//     la pantalla del taxista dice «Central», no «error»;
//   · la voz de la Central queda firmada como tal (de_central, sin conductor);
//   · y el canal es de ida y vuelta: lo del taxista le aparece a la Central.
test('radio: la Central escucha, pide la palabra y emite con su nombre', async () => {
  const uuidTaxi = randomUUID();
  const alta = await app.inject({
    method: 'POST', url: '/api/conductor/alta', headers: cabeceras(uuidTaxi),
    payload: {
      nombre: 'Taxista de la radio', telefono: telefonoUnico(),
      matricula: `MB-${Date.now() % 100000}R`, marca: 'Toyota', carroceria: 'turismo',
    },
  });
  assert.equal(alta.statusCode, 200, alta.body);

  // La Central pide la palabra…
  const turno = await app.inject({
    method: 'POST', url: '/api/operador/radio/turno', headers: cabeceras(UUID_OPERADOR),
    payload: {},
  });
  assert.equal(turno.statusCode, 200, turno.body);
  assert.equal(turno.json().dada, true);

  // …y el taxista que aprieta ve OCUPADO por «Central», no un error.
  const ocupado = await app.inject({
    method: 'POST', url: '/api/conductor/radio/turno', headers: cabeceras(uuidTaxi),
    payload: {},
  });
  assert.equal(ocupado.statusCode, 409, ocupado.body);
  assert.equal(ocupado.json().habla, 'Central');

  // La Central emite. El audio es de mentira; lo que importa es la firma.
  const emitido = await app.inject({
    method: 'POST', url: '/api/operador/radio/mensaje', headers: {
      ...cabeceras(UUID_OPERADOR),
      'content-type': 'audio/webm',
      'x-duracion-ms': '1200',
    },
    payload: Buffer.from('audio de mentira de la central'),
  });
  assert.equal(emitido.statusCode, 200, emitido.body);
  const mensajeId = Number(emitido.json().mensajeId);

  const firma = await pool.query(
    'SELECT conductor_id, de_central FROM mensaje_voz WHERE id = $1',
    [mensajeId],
  );
  assert.equal(firma.rows[0].conductor_id, null);
  assert.equal(firma.rows[0].de_central, true);

  // El taxista lo ve en su lista como «Central», y puede bajar el audio.
  const suRadio = await app.inject({
    method: 'GET', url: '/api/conductor/radio', headers: cabeceras(uuidTaxi),
  });
  assert.equal(suRadio.statusCode, 200, suRadio.body);
  const visto = suRadio.json().mensajes.find((m: { id: number }) => m.id === mensajeId);
  assert.equal(visto?.nombre, 'Central');
  assert.equal(visto?.mio, false);
  const bajada = await app.inject({
    method: 'GET', url: `/api/conductor/radio/mensaje/${mensajeId}/audio`,
    headers: cabeceras(uuidTaxi),
  });
  assert.equal(bajada.statusCode, 200);

  // Y al revés: el canal quedó libre al emitir, el taxista habla y la
  // Central lo ve con su nombre — y lo suyo propio como «mío».
  const turnoTaxi = await app.inject({
    method: 'POST', url: '/api/conductor/radio/turno', headers: cabeceras(uuidTaxi),
    payload: {},
  });
  assert.equal(turnoTaxi.statusCode, 200, turnoTaxi.body);
  const delTaxi = await app.inject({
    method: 'POST', url: '/api/conductor/radio/mensaje', headers: {
      ...cabeceras(uuidTaxi),
      'content-type': 'audio/webm',
      'x-duracion-ms': '900',
    },
    payload: Buffer.from('audio de mentira del taxista'),
  });
  assert.equal(delTaxi.statusCode, 200, delTaxi.body);

  const laCentralVe = await app.inject({
    method: 'GET', url: '/api/operador/radio', headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(laCentralVe.statusCode, 200, laCentralVe.body);
  const mensajes = laCentralVe.json().mensajes as Array<{ id: number; nombre: string; mio: boolean }>;
  const elDelTaxi = mensajes.find((m) => m.id === Number(delTaxi.json().mensajeId));
  assert.equal(elDelTaxi?.nombre, 'Taxista de la radio');
  assert.equal(elDelTaxi?.mio, false);
  assert.equal(mensajes.find((m) => m.id === mensajeId)?.mio, true, 'lo de la Central es «mío» para la Central');

  // Y la puerta es una puerta: un uuid cualquiera no entra a la radio del
  // operador.
  const intruso = await app.inject({
    method: 'GET', url: '/api/operador/radio', headers: cabeceras(randomUUID()),
  });
  assert.equal(intruso.statusCode, 403);
});

test('alta por el operador: verificado, número por confirmar y sin robarle el aparato', async () => {
  const telefono = telefonoUnico();
  const res = await app.inject({
    method: 'POST', url: '/api/operador/conductores', headers: cabeceras(UUID_OPERADOR),
    payload: {
      nombre: 'Alta del panel', apellido: 'Obiang', telefono, dip: dipUnico(),
      duenoConduce: true,
      matricula: `MB-${telefono.slice(-5)}P`, marca: 'Toyota', carroceria: 'turismo',
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const conductorId = Number(res.json().conductorId);

  const fila = await pool.query(
    'SELECT estado_verificacion, telefono_verificado_en FROM conductor WHERE id = $1',
    [conductorId],
  );
  assert.equal(fila.rows[0].estado_verificacion, 'verificado');
  assert.equal(fila.rows[0].telefono_verificado_en, null, 'la línea aún no demostró nada');

  const aparato = await pool.query(
    'SELECT 1 FROM dispositivo WHERE conductor_id = $1',
    [conductorId],
  );
  assert.equal(aparato.rowCount, 0, 'el aparato del operador no es el taxi');

  // Y el taxista entra desde SU móvil con solo el número, como siempre.
  const registro = await app.inject({
    method: 'POST', url: '/api/conductor/registro', headers: cabeceras(randomUUID()),
    payload: { telefono },
  });
  assert.equal(registro.statusCode, 200, registro.body);

  // Repetir el alta con el mismo número avisa con el nombre de quien ya lo tiene.
  const repetida = await app.inject({
    method: 'POST', url: '/api/operador/conductores', headers: cabeceras(UUID_OPERADOR),
    payload: {
      nombre: 'Otro', apellido: 'Nguema', telefono, dip: dipUnico(), duenoConduce: true,
      matricula: 'MB-XXXXX', marca: 'Kia', carroceria: 'turismo',
    },
  });
  assert.equal(repetida.statusCode, 409);
  assert.match(repetida.json().error, /Alta del panel/);
});

// El propietario (migración 087): el dueño distinto del conductor, la flota
// —dos coches del mismo DIP reutilizan la ficha— y las validaciones del DIP y
// de los tipos nuevos de vehículo.
// Editar los datos del taxista y subir su foto (migraciones 087/088).
test('ficha: editar datos del taxista y subir su foto', async () => {
  const telefono = telefonoUnico();
  const alta = await app.inject({
    method: 'POST', url: '/api/operador/conductores', headers: cabeceras(UUID_OPERADOR),
    payload: {
      nombre: 'Antes', apellido: 'Viejo', telefono, dip: dipUnico(), duenoConduce: true,
      matricula: `MB-${telefono.slice(-5)}E`, marca: 'Toyota', carroceria: 'turismo',
    },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  const id = Number(alta.json().conductorId);

  // Editar nombre, apellido y correo.
  const nuevoDip = dipUnico();
  const editar = await app.inject({
    method: 'POST', url: `/api/operador/conductores/${id}/datos`, headers: cabeceras(UUID_OPERADOR),
    payload: { nombre: 'Ahora', apellido: 'Nuevo', dip: nuevoDip, correo: 'a@b.com' },
  });
  assert.equal(editar.statusCode, 200, editar.body);
  const fila = await pool.query('SELECT nombre, apellido, dip, correo FROM conductor WHERE id = $1', [id]);
  assert.equal(fila.rows[0].nombre, 'Ahora');
  assert.equal(fila.rows[0].apellido, 'Nuevo');
  assert.equal(fila.rows[0].dip, nuevoDip);
  assert.equal(fila.rows[0].correo, 'a@b.com');

  // Un DIP de tres cifras no cuela.
  const malDip = await app.inject({
    method: 'POST', url: `/api/operador/conductores/${id}/datos`, headers: cabeceras(UUID_OPERADOR),
    payload: { nombre: 'X', apellido: 'Y', dip: '12' },
  });
  assert.equal(malDip.statusCode, 400);

  // La ficha empieza sin foto; tras subirla, tiene_foto es true y se sirve.
  const sinFoto = await app.inject({
    method: 'GET', url: `/api/operador/conductores/${id}`, headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(sinFoto.json().tiene_foto, false);

  const subir = await app.inject({
    method: 'POST', url: `/api/operador/conductores/${id}/foto`,
    headers: { ...cabeceras(UUID_OPERADOR), 'content-type': 'image/jpeg' },
    payload: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  assert.equal(subir.statusCode, 200, subir.body);

  const conFoto = await app.inject({
    method: 'GET', url: `/api/operador/conductores/${id}`, headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(conFoto.json().tiene_foto, true);

  const servida = await app.inject({
    method: 'GET', url: `/api/operador/conductores/${id}/foto`, headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(servida.statusCode, 200);
  assert.match(servida.headers['content-type'] as string, /image\/jpeg/);
});

test('alta con propietario: dueño aparte, flota por DIP, y DIP/carrocería validados', async () => {
  const dipDueno = dipUnico();
  function altaConDueno(extra: Record<string, unknown> = {}) {
    const telefono = telefonoUnico();
    return app.inject({
      method: 'POST', url: '/api/operador/conductores', headers: cabeceras(UUID_OPERADOR),
      payload: {
        nombre: 'Conductor', apellido: 'Empleado', telefono, dip: dipUnico(),
        duenoConduce: false,
        propietario: {
          nombre: 'Doña', apellido: 'Dueña', telefono: telefonoUnico(), dip: dipDueno,
        },
        matricula: `MB-${telefono.slice(-5)}D`, marca: 'Toyota', carroceria: 'furgoneta',
        ...extra,
      },
    });
  }

  const primera = await altaConDueno();
  assert.equal(primera.statusCode, 200, primera.body);
  const id1 = Number(primera.json().conductorId);

  // El coche quedó con su dueño, y el dueño NO es el conductor.
  const v1 = await pool.query(
    `SELECT p.dip AS dip_dueno, p.nombre, c.dip AS dip_conductor, v.carroceria
     FROM vehiculo v JOIN propietario p ON p.id = v.propietario_id
     JOIN conductor c ON c.id = v.conductor_id WHERE v.conductor_id = $1`,
    [id1],
  );
  assert.equal(v1.rows[0].dip_dueno, dipDueno);
  assert.equal(v1.rows[0].carroceria, 'furgoneta');
  assert.notEqual(v1.rows[0].dip_dueno, v1.rows[0].dip_conductor, 'dueño ≠ conductor');

  // La FLOTA: otro coche con el MISMO DIP de dueño reutiliza su ficha, no
  // crea una segunda.
  const segunda = await altaConDueno({ carroceria: 'autobus' });
  assert.equal(segunda.statusCode, 200, segunda.body);
  const cuantosDuenos = await pool.query(
    'SELECT count(*)::int AS n FROM propietario WHERE dip = $1',
    [dipDueno],
  );
  assert.equal(cuantosDuenos.rows[0].n, 1, 'un DIP, un propietario, aunque tenga dos coches');

  // DIP del conductor mal (no nueve dígitos): 400, y lo dice.
  const dipMalo = await altaConDueno({ dip: '123' });
  assert.equal(dipMalo.statusCode, 400);
  assert.match(dipMalo.json().error, /DIP/);

  // Carrocería inventada: 400.
  const tipoMalo = await altaConDueno({ carroceria: 'tanque' });
  assert.equal(tipoMalo.statusCode, 400);

  // Mismo DIP de conductor en dos altas distintas: la segunda, 409.
  const dipCompartido = dipUnico();
  const unoA = await altaConDueno({ dip: dipCompartido });
  assert.equal(unoA.statusCode, 200, unoA.body);
  const unoB = await altaConDueno({ dip: dipCompartido });
  assert.equal(unoB.statusCode, 409);
  assert.match(unoB.json().error, /DIP/);
});

// Editar en la ficha (08/10): los datos del dueño en su pestaña, y el
// vehículo en la suya con el candado del coche validado.
test('editar: el dueño y su DIP, y el vehículo con la matrícula bloqueada si está validado', async () => {
  const telefono = telefonoUnico();
  const dipDueno = dipUnico();
  const alta = await app.inject({
    method: 'POST', url: '/api/operador/conductores', headers: cabeceras(UUID_OPERADOR),
    payload: {
      nombre: 'Jefa', apellido: 'Gómez', telefono, dip: dipUnico(), duenoConduce: false,
      propietario: { nombre: 'Don', apellido: 'Dueño', telefono: telefonoUnico(), dip: dipDueno },
      matricula: `MB-${telefono.slice(-5)}E`, marca: 'Kia', carroceria: 'turismo',
    },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  const conductorId = Number(alta.json().conductorId);

  // Nace verificado (alta por el operador), así que el coche está validado.
  const ficha = await app.inject({
    method: 'GET', url: `/api/operador/conductores/${conductorId}`, headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(ficha.json().estado_verificacion, 'verificado');
  const propietarioId = Number(ficha.json().propietario.id);

  // Editar el dueño: nombre, teléfono y DIP nuevos, y se guardan.
  const dipNuevo = dipUnico();
  const editado = await app.inject({
    method: 'POST', url: `/api/operador/propietarios/${propietarioId}/datos`, headers: cabeceras(UUID_OPERADOR),
    payload: { nombre: 'Doña', apellido: 'Jefa', telefono: telefonoUnico(), dip: dipNuevo },
  });
  assert.equal(editado.statusCode, 200, editado.body);
  const trasEditar = await pool.query(
    'SELECT nombre, dip FROM propietario WHERE id = $1', [propietarioId],
  );
  assert.equal(trasEditar.rows[0].nombre, 'Doña');
  assert.equal(trasEditar.rows[0].dip, dipNuevo);

  // El DIP de OTRO propietario: 409, no se funden dos dueños.
  const otroDip = dipUnico();
  await app.inject({
    method: 'POST', url: '/api/operador/conductores', headers: cabeceras(UUID_OPERADOR),
    payload: {
      nombre: 'Otra', apellido: 'Jefa', telefono: telefonoUnico(), dip: dipUnico(), duenoConduce: false,
      propietario: { nombre: 'Otro', apellido: 'Dueño', telefono: telefonoUnico(), dip: otroDip },
      matricula: `MB-${telefonoUnico().slice(-5)}F`, marca: 'Kia', carroceria: 'turismo',
    },
  });
  const choca = await app.inject({
    method: 'POST', url: `/api/operador/propietarios/${propietarioId}/datos`, headers: cabeceras(UUID_OPERADOR),
    payload: { nombre: 'Doña', apellido: 'Jefa', telefono: telefonoUnico(), dip: otroDip },
  });
  assert.equal(choca.statusCode, 409, choca.body);
  assert.match(choca.json().error, /DIP/);

  // El vehículo: color y plazas se tocan aunque esté validado.
  const vehiculo = await app.inject({
    method: 'POST', url: `/api/operador/conductores/${conductorId}/vehiculo`, headers: cabeceras(UUID_OPERADOR),
    payload: { aireAcondicionado: true, seguro: false, color: 'Azul', plazas: 4 },
  });
  assert.equal(vehiculo.statusCode, 200, vehiculo.body);
  assert.equal(vehiculo.json().color, 'Azul');
  assert.equal(vehiculo.json().plazas, 4);
  assert.equal(vehiculo.json().aire_acondicionado, true);

  // Plazas fuera del rango del taxi compartido (1-4): 400 claro, no un 500
  // contra el CHECK de la base.
  const plazasMal = await app.inject({
    method: 'POST', url: `/api/operador/conductores/${conductorId}/vehiculo`, headers: cabeceras(UUID_OPERADOR),
    payload: { aireAcondicionado: true, seguro: false, plazas: 7 },
  });
  assert.equal(plazasMal.statusCode, 400, plazasMal.body);

  // La matrícula NO, mientras esté validado: 409.
  const matriculaBloqueada = await app.inject({
    method: 'POST', url: `/api/operador/conductores/${conductorId}/vehiculo`, headers: cabeceras(UUID_OPERADOR),
    payload: { aireAcondicionado: true, seguro: false, matricula: 'MB-00000Z' },
  });
  assert.equal(matriculaBloqueada.statusCode, 409, matriculaBloqueada.body);
});

// Las plazas por tipo (migración 089): una furgoneta admite más de 4; un
// turismo, no.
test('plazas: la furgoneta pasa de 4, el turismo no', async () => {
  function alta(carroceria: string, plazas: number | undefined) {
    const telefono = telefonoUnico();
    return app.inject({
      method: 'POST', url: '/api/operador/conductores', headers: cabeceras(UUID_OPERADOR),
      payload: {
        nombre: 'Chófer', apellido: 'Bus', telefono, dip: dipUnico(), duenoConduce: true,
        matricula: `MB-${telefono.slice(-5)}V`, marca: 'Toyota', carroceria, plazas,
      },
    });
  }

  // Furgoneta con 12 plazas: entra, y la base las guarda.
  const furgo = await alta('furgoneta', 12);
  assert.equal(furgo.statusCode, 200, furgo.body);
  const idFurgo = Number(furgo.json().conductorId);
  const plazasFurgo = await pool.query(
    'SELECT plazas FROM vehiculo WHERE conductor_id = $1', [idFurgo],
  );
  assert.equal(plazasFurgo.rows[0].plazas, 12);

  // Turismo con 12: fuera, el tope del turismo es 4.
  const turismo = await alta('turismo', 12);
  assert.equal(turismo.statusCode, 400, turismo.body);

  // Sin plazas: la base pone 4.
  const porDefecto = await alta('turismo', undefined);
  assert.equal(porDefecto.statusCode, 200, porDefecto.body);
  const idDef = Number(porDefecto.json().conductorId);
  const plazasDef = await pool.query(
    'SELECT plazas FROM vehiculo WHERE conductor_id = $1', [idDef],
  );
  assert.equal(plazasDef.rows[0].plazas, 4);

  // Editar la furgoneta a 16 (su tope): entra; a 17, fuera.
  const a16 = await app.inject({
    method: 'POST', url: `/api/operador/conductores/${idFurgo}/vehiculo`, headers: cabeceras(UUID_OPERADOR),
    payload: { aireAcondicionado: false, seguro: false, plazas: 16 },
  });
  assert.equal(a16.statusCode, 200, a16.body);
  assert.equal(a16.json().plazas, 16);
  const a17 = await app.inject({
    method: 'POST', url: `/api/operador/conductores/${idFurgo}/vehiculo`, headers: cabeceras(UUID_OPERADOR),
    payload: { aireAcondicionado: false, seguro: false, plazas: 17 },
  });
  assert.equal(a17.statusCode, 400, a17.body);
});

// Hacer dueño al taxista (09/10): su coche, registrado a nombre de otro, pasa
// a su propio nombre con un botón.
test('hacer dueño al taxista: su coche pasa a su nombre', async () => {
  const dipConductor = dipUnico();
  const telefono = telefonoUnico();
  const alta = await app.inject({
    method: 'POST', url: '/api/operador/conductores', headers: cabeceras(UUID_OPERADOR),
    payload: {
      nombre: 'Chófer', apellido: 'Empleado', telefono, dip: dipConductor, duenoConduce: false,
      propietario: { nombre: 'Otro', apellido: 'Dueño', telefono: telefonoUnico(), dip: dipUnico() },
      matricula: `MB-${telefono.slice(-5)}H`, marca: 'Toyota', carroceria: 'turismo',
    },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  const id = Number(alta.json().conductorId);

  const dipDueno = async () => (await pool.query(
    `SELECT p.dip FROM vehiculo v JOIN propietario p ON p.id = v.propietario_id
     WHERE v.conductor_id = $1`, [id],
  )).rows[0].dip;
  assert.notEqual(await dipDueno(), dipConductor, 'empieza a nombre de otro');

  const r = await app.inject({
    method: 'POST', url: `/api/operador/conductores/${id}/dueno-es-el-conductor`,
    headers: cabeceras(UUID_OPERADOR), payload: {},
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await dipDueno(), dipConductor, 'ahora el dueño es el propio taxista');
});

// La flota (09/10): elegir un dueño YA registrado en el alta le cuelga otro
// coche, con otro taxista. Así un dueño acumula varios coches y conductores.
test('flota: un dueño existente recibe otro coche con otro taxista', async () => {
  function altaCon(extra: Record<string, unknown>) {
    const telefono = telefonoUnico();
    return app.inject({
      method: 'POST', url: '/api/operador/conductores', headers: cabeceras(UUID_OPERADOR),
      payload: {
        nombre: 'Taxista', apellido: 'Flota', telefono, dip: dipUnico(),
        matricula: `MB-${telefono.slice(-5)}${Math.floor(Math.random() * 9)}`,
        marca: 'Toyota', carroceria: 'turismo',
        ...extra,
      },
    });
  }

  // Primer coche, dueño nuevo.
  const dipDueno = dipUnico();
  const primera = await altaCon({
    duenoConduce: false,
    propietario: { nombre: 'Don', apellido: 'Flota', telefono: telefonoUnico(), dip: dipDueno },
  });
  assert.equal(primera.statusCode, 200, primera.body);
  const idA = Number(primera.json().conductorId);
  const propId = Number((await pool.query(
    `SELECT p.id FROM vehiculo v JOIN propietario p ON p.id = v.propietario_id
     WHERE v.conductor_id = $1`, [idA],
  )).rows[0].id);

  // Segundo coche: MISMO dueño elegido por id, OTRO taxista.
  const segunda = await altaCon({ duenoConduce: false, propietarioId: propId });
  assert.equal(segunda.statusCode, 200, segunda.body);
  const idB = Number(segunda.json().conductorId);
  assert.notEqual(idA, idB);

  const flota = await pool.query(
    `SELECT count(*)::int AS coches, count(DISTINCT conductor_id)::int AS conductores
     FROM vehiculo WHERE propietario_id = $1`, [propId],
  );
  assert.equal(flota.rows[0].coches, 2, 'dos coches del mismo dueño');
  assert.equal(flota.rows[0].conductores, 2, 'dos taxistas distintos');

  // Un dueño que no existe: 404.
  const malo = await altaCon({ duenoConduce: false, propietarioId: 999_999_999 });
  assert.equal(malo.statusCode, 404, malo.body);
});

// Los roles de operador (migración 090): cada perfil solo TOCA lo suyo; leer,
// lo lee cualquiera; la raíz lo puede todo.
test('roles: cada perfil solo modifica lo suyo, y la consulta solo lee', async () => {
  async function operadorCon(roles: string[]): Promise<string> {
    const telefono = telefonoUnico();
    const uuid = randomUUID();
    await pool.query(
      'INSERT INTO operador_autorizado (telefono, nombre, alta_por, roles) VALUES ($1, $2, $3, $4)',
      [telefono, 'Perfil', 'test', roles],
    );
    await pool.query(
      'INSERT INTO operador_dispositivo (uuid_dispositivo, telefono) VALUES ($1, $2)',
      [uuid, telefono],
    );
    return uuid;
  }
  function altaPayload() {
    const telefono = telefonoUnico();
    return {
      nombre: 'Alta', apellido: 'Rol', telefono, dip: dipUnico(), duenoConduce: true,
      matricula: `MB-${telefono.slice(-5)}R`, marca: 'Kia', carroceria: 'turismo',
    };
  }

  // Solo DESPACHO.
  const desp = await operadorCon(['despacho']);
  const yo = await app.inject({ method: 'GET', url: '/api/operador/yo', headers: cabeceras(desp) });
  assert.equal(yo.statusCode, 200, yo.body);
  assert.deepEqual(yo.json().permisos, ['despacho']);
  assert.equal(yo.json().admin, false);
  // Leer, sí (cualquier operador).
  assert.equal((await app.inject({ method: 'GET', url: '/api/operador/viajes', headers: cabeceras(desp) })).statusCode, 200);
  // Dar de alta un taxista, NO (es de taxistas).
  const altaDesp = await app.inject({
    method: 'POST', url: '/api/operador/conductores', headers: cabeceras(desp), payload: altaPayload(),
  });
  assert.equal(altaDesp.statusCode, 403, altaDesp.body);

  // Solo TAXISTAS.
  const tax = await operadorCon(['taxistas']);
  const altaTax = await app.inject({
    method: 'POST', url: '/api/operador/conductores', headers: cabeceras(tax), payload: altaPayload(),
  });
  assert.equal(altaTax.statusCode, 200, altaTax.body);
  // Confirmar un pago, NO (es de suscripciones): 403 por permiso, antes de
  // mirar la recarga.
  const pagoTax = await app.inject({
    method: 'POST', url: '/api/operador/recargas/NO-EXISTE/confirmar',
    headers: cabeceras(tax), payload: { comprobante: 'x' },
  });
  assert.equal(pagoTax.statusCode, 403, pagoTax.body);

  // CONSULTA (sin roles): lee pero no toca nada.
  const con = await operadorCon([]);
  assert.equal((await app.inject({ method: 'GET', url: '/api/operador/estadisticas', headers: cabeceras(con) })).statusCode, 200);
  const tocaCon = await app.inject({
    method: 'POST', url: '/api/operador/conductores', headers: cabeceras(con), payload: altaPayload(),
  });
  assert.equal(tocaCon.statusCode, 403, tocaCon.body);
  const yoCon = await app.inject({ method: 'GET', url: '/api/operador/yo', headers: cabeceras(con) });
  assert.deepEqual(yoCon.json().permisos, []);

  // La RAÍZ del entorno lo puede todo.
  const yoAdmin = await app.inject({ method: 'GET', url: '/api/operador/yo', headers: cabeceras(UUID_OPERADOR) });
  assert.equal(yoAdmin.json().admin, true);
  assert.equal(yoAdmin.json().permisos.length, 4);
  const altaAdmin = await app.inject({
    method: 'POST', url: '/api/operador/conductores', headers: cabeceras(UUID_OPERADOR), payload: altaPayload(),
  });
  assert.equal(altaAdmin.statusCode, 200, altaAdmin.body);
});

// La raíz reparte y cambia los perfiles desde el panel de accesos (migración
// 090); un operador normal no.
test('accesos: la raíz da un perfil y lo cambia; otro no puede', async () => {
  const tel = telefonoUnico();
  const dar = await app.inject({
    method: 'POST', url: '/api/operador/accesos', headers: cabeceras(UUID_OPERADOR),
    payload: { telefono: tel, nombre: 'Con perfil', roles: ['despacho'] },
  });
  assert.equal(dar.statusCode, 200, dar.body);

  const buscarFila = async () => (await app.inject({
    method: 'GET', url: '/api/operador/accesos', headers: cabeceras(UUID_OPERADOR),
  })).json().operadores.find((o: { telefono: string }) => o.telefono === tel);
  assert.deepEqual((await buscarFila()).roles, ['despacho']);

  // Cambiarle el perfil.
  const cambia = await app.inject({
    method: 'POST', url: '/api/operador/accesos/roles', headers: cabeceras(UUID_OPERADOR),
    payload: { telefono: tel, roles: ['suscripciones', 'taxistas', 'inventado'] },
  });
  assert.equal(cambia.statusCode, 200, cambia.body);
  // El rol inventado se descarta; quedan los dos válidos.
  assert.deepEqual([...(await buscarFila()).roles].sort(), ['suscripciones', 'taxistas']);

  // Un aparato que no es de la raíz no reparte perfiles.
  const ajeno = await app.inject({
    method: 'POST', url: '/api/operador/accesos/roles', headers: cabeceras(randomUUID()),
    payload: { telefono: tel, roles: [] },
  });
  assert.equal(ajeno.statusCode, 403, ajeno.body);
});

// Renovar la cuota (migración 090): solo el perfil de suscripciones, y suma
// días a lo que le quedaba.
test('suscripción: suscripciones renueva la cuota y suma días; despacho no', async () => {
  async function operadorDe(roles: string[]): Promise<string> {
    const telefono = telefonoUnico();
    const uuid = randomUUID();
    await pool.query(
      'INSERT INTO operador_autorizado (telefono, nombre, alta_por, roles) VALUES ($1, $2, $3, $4)',
      [telefono, 'Perfil', 'test', roles],
    );
    await pool.query(
      'INSERT INTO operador_dispositivo (uuid_dispositivo, telefono) VALUES ($1, $2)',
      [uuid, telefono],
    );
    return uuid;
  }

  const telefono = telefonoUnico();
  const alta = await app.inject({
    method: 'POST', url: '/api/operador/conductores', headers: cabeceras(UUID_OPERADOR),
    payload: {
      nombre: 'Cuota', apellido: 'Taxi', telefono, dip: dipUnico(), duenoConduce: true,
      matricula: `MB-${telefono.slice(-5)}C`, marca: 'Kia', carroceria: 'turismo',
    },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  const id = Number(alta.json().conductorId);
  const antes = (await pool.query('SELECT suscrito_hasta FROM conductor WHERE id = $1', [id])).rows[0].suscrito_hasta;

  const sus = await operadorDe(['suscripciones']);
  const r = await app.inject({
    method: 'POST', url: `/api/operador/conductores/${id}/suscripcion`,
    headers: cabeceras(sus), payload: { periodos: 2 },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().dias, 14, 'dos cuotas de 7 días');
  const despues = (await pool.query('SELECT suscrito_hasta FROM conductor WHERE id = $1', [id])).rows[0].suscrito_hasta;
  assert.ok(new Date(despues) > new Date(antes), 'la cuota se extendió');

  // Un operador de despacho no renueva cuotas.
  const desp = await operadorDe(['despacho']);
  const no = await app.inject({
    method: 'POST', url: `/api/operador/conductores/${id}/suscripcion`,
    headers: cabeceras(desp), payload: { periodos: 1 },
  });
  assert.equal(no.statusCode, 403, no.body);
});

test('oferta dirigida: llega al taxi de otra zona, firmada, y sin duplicar', async () => {
  const { zonaId, origenId, destinoId } = await crearZonaConReferencias();
  const otraZona = await crearZonaConReferencias();
  const deAqui = await taxistaListo(zonaId);
  const deAlli = await taxistaListo(otraZona.zonaId);

  // La carrera nace por la central y queda EMITIDO: hay un taxi vivo en la
  // zona (deAqui), que recibe la oleada 1.
  const creada = await app.inject({
    method: 'POST', url: '/api/operador/solicitudes', headers: cabeceras(UUID_OPERADOR),
    payload: {
      telefono: `+240333${Date.now() % 1000000}${Math.floor(Math.random() * 90 + 10)}`,
      origenId, destinoId,
    },
  });
  assert.equal(creada.statusCode, 201, creada.body);
  assert.equal(creada.json().estado, 'EMITIDO', 'con un taxi vivo en la zona no puede morir');
  const solicitudId = Number(creada.json().solicitudId);

  // El de la otra zona no tiene oferta: ninguna oleada lo habría llamado aún.
  const antes = await pool.query(
    'SELECT 1 FROM oferta WHERE solicitud_id = $1 AND conductor_id = $2',
    [solicitudId, deAlli],
  );
  assert.equal(antes.rowCount, 0);

  const dirigida = await app.inject({
    method: 'POST', url: `/api/operador/viajes/${solicitudId}/ofrecer`,
    headers: cabeceras(UUID_OPERADOR), payload: { conductorId: deAlli },
  });
  assert.equal(dirigida.statusCode, 200, dirigida.body);

  const oferta = await pool.query(
    `SELECT oleada, resultado FROM oferta WHERE solicitud_id = $1 AND conductor_id = $2`,
    [solicitudId, deAlli],
  );
  assert.equal(oferta.rowCount, 1);
  assert.equal(Number(oferta.rows[0].oleada), 6, 'fuera de la contabilidad de las oleadas 1-4');
  assert.equal(oferta.rows[0].resultado, null, 'viva: el taxista decide');

  // Firmada: el registro dice que la mandó el operador, no el reloj.
  const firma = await pool.query(
    `SELECT actor, origen_evento FROM transicion
     WHERE conductor_id = $1 AND estado_nuevo = 'OFERTADO'
     ORDER BY creado_en DESC LIMIT 1`,
    [deAlli],
  );
  assert.equal(firma.rows[0].actor, 'operador');
  assert.equal(firma.rows[0].origen_evento, 'oferta_dirigida');

  // Al que ya la tiene delante (oleada 1) no se le duplica.
  const duplicada = await app.inject({
    method: 'POST', url: `/api/operador/viajes/${solicitudId}/ofrecer`,
    headers: cabeceras(UUID_OPERADOR), payload: { conductorId: deAqui },
  });
  assert.equal(duplicada.statusCode, 409, duplicada.body);

  // Y la carrera sigue EMITIDO: ofrecer no asigna, avisa.
  const estado = await pool.query('SELECT estado FROM solicitud WHERE id = $1', [solicitudId]);
  assert.equal(estado.rows[0].estado, 'EMITIDO');
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

// El 403 del 06/10: «los precios no se pueden poner desde el ordenador». El
// guardián del trabajo de campo se quedó mirando solo la lista vieja de uuids
// cuando la 080 estrenó la entrada por teléfono, y el operador que entraba
// por SMS no podía fijar una banda. Y de propina, sus cambios quedaban
// apuntados como «ni operador ni conductor».
test('campo: el operador que entró por teléfono fija precios, y firma como operador', async () => {
  const porTelefono = await entrarComoOperador(raizNueva());
  const { zonaId } = await crearZonaConReferencias();
  const otra = await crearZonaConReferencias();

  const res = await app.inject({
    method: 'POST', url: '/api/operador/bandas', headers: cabeceras(porTelefono),
    payload: { zonaOrigenId: zonaId, zonaDestinoId: otra.zonaId, p25: 900, p50: 1400, p75: 1900 },
  });
  assert.equal(res.statusCode, 200, res.body);

  const cambios = await app.inject({
    method: 'GET', url: '/api/operador/cambios', headers: cabeceras(porTelefono),
  });
  const mio = cambios.json().cambios.find(
    (c: { clave: string }) => c.clave === `${zonaId}→${otra.zonaId}`,
  );
  assert.equal(mio?.quien, 'operador', 'el registro dice QUIÉN fue, no «nadie»');
});

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

test('nombrar agente a un pasajero le alcanza en TODOS sus teléfonos', async () => {
  // El fallo que arregla, visto en producción (30/09): `perfil_cliente` va por
  // dispositivo, y una persona acumula un perfil por cada navegador,
  // reinstalación o borrado de datos. Un número tenía OCHO perfiles, tres
  // marcados como agente y el que usaba ese día sin marcar: el operador veía
  // «agente» en su panel y la persona no tenía el botón.
  const telefono = `+2402224${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
  const { viejo, nuevo } = await enTransaccion(pool, async (c) => {
    const uno = await c.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo)
       VALUES (gen_random_uuid(), 'cliente') RETURNING id`,
    );
    const dos = await c.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo)
       VALUES (gen_random_uuid(), 'cliente') RETURNING id`,
    );
    // Como en la vida real: el viejo dejó de ser el vigente cuando la persona
    // reclamó su número desde el teléfono nuevo (migración 024). El perfil
    // viejo conserva su fila y su historial, pero ya no es el suyo de ahora.
    await c.query(
      `INSERT INTO perfil_cliente (dispositivo_id, telefono, telefono_verificado_en,
                                   telefono_vigente)
       VALUES ($1, $2, now(), false)`,
      [uno.rows[0].id, telefono],
    );
    await c.query(
      `INSERT INTO perfil_cliente (dispositivo_id, telefono, telefono_verificado_en,
                                   telefono_vigente)
       VALUES ($1, $2, now(), true)`,
      [dos.rows[0].id, telefono],
    );
    return { viejo: Number(uno.rows[0].id), nuevo: Number(dos.rows[0].id) };
  });

  // El operador marca el perfil VIEJO —que es lo que pasó: en producción se
  // marcó un dispositivo de hace dos días y la persona usaba otro—.
  const res = await app.inject({
    method: 'POST',
    url: `/api/operador/pasajeros/${viejo}/agente`,
    headers: cabeceras(UUID_OPERADOR),
    payload: { agente: true },
  });
  assert.equal(res.statusCode, 200, res.body);

  // Y le alcanza también al teléfono que usa hoy, que es de lo que se trata.
  const otro = await pool.query(
    'SELECT es_agente FROM perfil_cliente WHERE dispositivo_id = $1', [nuevo],
  );
  assert.equal(otro.rows[0].es_agente, true,
    'el papel es de la persona, no del aparato con el que se conectó aquel día');

  // Y quitarlo lo quita en los dos: si no, se creería haberlo retirado.
  await app.inject({
    method: 'POST',
    url: `/api/operador/pasajeros/${viejo}/agente`,
    headers: cabeceras(UUID_OPERADOR),
    payload: { agente: false },
  });
  const tras = await pool.query(
    'SELECT es_agente FROM perfil_cliente WHERE telefono = $1', [telefono],
  );
  assert.ok(tras.rows.every((f) => f.es_agente === false), 'se retira de todos');

  await pool.query('DELETE FROM perfil_cliente WHERE telefono = $1', [telefono]);
  await pool.query('DELETE FROM dispositivo WHERE id = ANY($1)', [[viejo, nuevo]]);
});

test('el pasajero agente puede VER los barrios desde cualquiera de sus teléfonos', async () => {
  // El fallo de verdad (30/09): la regla de «quién es agente» estaba escrita
  // dos veces. Al arreglar la de la sesión, a la persona le aparecía el botón
  // de trabajo de campo, y al pulsarlo se llevaba un «este dispositivo no puede
  // hacer trabajo de campo» del guardián, que seguía mirando la bandera del
  // aparato. Ahora la regla está en un solo sitio.
  const telefono = `+2402225${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
  const { marcado, deHoy } = await enTransaccion(pool, async (c) => {
    const viejo = await c.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo)
       VALUES (gen_random_uuid(), 'cliente') RETURNING id, uuid_persistente`,
    );
    const nuevo = await c.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo)
       VALUES (gen_random_uuid(), 'cliente') RETURNING id, uuid_persistente`,
    );
    // El viejo es el que tiene la bandera; el de hoy, no. Es el caso de
    // producción tal cual.
    await c.query(
      `INSERT INTO perfil_cliente (dispositivo_id, telefono, telefono_verificado_en,
                                   telefono_vigente, es_agente)
       VALUES ($1, $2, now(), false, true)`,
      [viejo.rows[0].id, telefono],
    );
    await c.query(
      `INSERT INTO perfil_cliente (dispositivo_id, telefono, telefono_verificado_en,
                                   telefono_vigente, es_agente)
       VALUES ($1, $2, now(), true, false)`,
      [nuevo.rows[0].id, telefono],
    );
    return { marcado: viejo.rows[0], deHoy: nuevo.rows[0] };
  });

  // Desde el teléfono de hoy, que NO tiene la bandera puesta.
  const res = await app.inject({
    method: 'GET', url: '/api/operador/zonas', headers: cabeceras(deHoy.uuid_persistente),
  });
  assert.equal(res.statusCode, 200,
    `el papel es de la persona: tiene que poder ver los barrios (${res.body})`);

  // Y alguien sin ningún papel sigue sin poder, que es lo que protege esto.
  const ajeno = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo)
     VALUES (gen_random_uuid(), 'cliente') RETURNING uuid_persistente`,
  );
  const negado = await app.inject({
    method: 'GET', url: '/api/operador/zonas',
    headers: cabeceras(ajeno.rows[0].uuid_persistente),
  });
  assert.equal(negado.statusCode, 403);

  await pool.query('DELETE FROM perfil_cliente WHERE telefono = $1', [telefono]);
  await pool.query('DELETE FROM dispositivo WHERE id = ANY($1)',
    [[marcado.id, deHoy.id]]);
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

// Crear un sitio con un nombre que ya existe en esa zona NO creaba otro: el
// alta hace un upsert por (zona, nombre), así que le cambiaba las coordenadas
// al que ya estaba y lo reactivaba, en silencio. Quien creía estar añadiendo un
// sitio nuevo estaba moviendo uno viejo, y el único rastro era que los taxis
// empezaban a ir a otra parte.
test('gazetteer: un nombre repetido en la misma zona avisa en vez de pisar', async () => {
  const { zonaId } = await crearZonaConReferencias();
  const nombre = `Bar Repetido ${Date.now()}`;

  const primera = await app.inject({
    method: 'POST', url: '/api/operador/referencias', headers: cabeceras(UUID_OPERADOR),
    payload: { zonaId, nombre, lat: 3.752, lng: 8.782, categoria: 'restaurante' },
  });
  assert.equal(primera.statusCode, 200, primera.body);
  assert.equal(primera.json().creada, true);

  // El mismo nombre, en la misma zona, con otras coordenadas.
  const choque = await app.inject({
    method: 'POST', url: '/api/operador/referencias', headers: cabeceras(UUID_OPERADOR),
    payload: { zonaId, nombre, lat: 3.760, lng: 8.770, categoria: 'restaurante' },
  });
  assert.equal(choque.statusCode, 409, 'tiene que preguntar, no pisar');
  // Y dice CUÁL es, para que la pantalla pueda ofrecer abrirlo o sustituirlo
  // sin mandar a nadie a buscarlo.
  assert.equal(choque.json().existente.nombre, nombre);
  assert.ok(choque.json().existente.id);

  // Las coordenadas del que ya estaba siguen intactas.
  const sinTocar = await app.inject({
    method: 'GET', url: `/api/operador/referencias?q=${encodeURIComponent(nombre)}`,
    headers: cabeceras(UUID_OPERADOR),
  });
  const suyo = sinTocar.json().referencias.find((r: { nombre: string }) => r.nombre === nombre);
  assert.ok(Math.abs(Number(suyo.lat) - 3.752) < 0.0001, 'no se le han tocado las coordenadas');

  // Con el consentimiento explícito sí se mueve, y se dice que NO se creó nada.
  const sustituido = await app.inject({
    method: 'POST', url: '/api/operador/referencias', headers: cabeceras(UUID_OPERADOR),
    payload: { zonaId, nombre, lat: 3.760, lng: 8.770, categoria: 'restaurante', sustituir: true },
  });
  assert.equal(sustituido.statusCode, 200, sustituido.body);
  assert.equal(sustituido.json().creada, false, 'sustituir mueve, no crea');
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
    //
    // Los minutos se cuentan desde la MEDIANOCHE DE HOY y no desde ahora, y se
    // consulta la semana. «Día» significa hoy desde las 00:00 —no las últimas
    // 24 horas, y es deliberado (ver `inicioDelDiaEnMalabo`)—, así que puntos
    // «de hace cinco horas» caen en ayer si la batería se lanza de madrugada.
    // Esta prueba falló a las 00:19 por eso: lo que mide son los TRAMOS, no la
    // frontera del día, y atarla a la hora del reloj la hacía fallar sola unas
    // horas al día.
    const medianoche = new Date();
    medianoche.setHours(0, 0, 0, 0);
    const hace = (min: number) => new Date(medianoche.getTime() - min * 60_000);
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
    method: 'GET', url: `/api/operador/conductores/${conductorId}/recorrido?periodo=semana`,
    headers: cabeceras(uuidAgente),
  });
  assert.equal(agente.statusCode, 403, 'un agente de campo no vigila a sus compañeros');

  const res = await app.inject({
    method: 'GET', url: `/api/operador/conductores/${conductorId}/recorrido?periodo=semana`,
    headers: cabeceras(UUID_OPERADOR),
  });
  assert.equal(res.statusCode, 200, res.body);
  const cuerpo = res.json();
  assert.equal(cuerpo.puntos, 4);
  assert.equal(cuerpo.tramos.length, 2, 'las cinco horas de hueco no se unen con una recta');
  assert.ok(cuerpo.metros > 300, `esperaba unos cientos de metros y salieron ${cuerpo.metros}`);
  // Los clientes llevados en el periodo (09/10): este taxista no completó
  // ninguna carrera, así que cero, pero el campo viaja siempre.
  assert.equal(cuerpo.clientesLlevados, 0, 'sin carreras completadas, cero clientes');

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
