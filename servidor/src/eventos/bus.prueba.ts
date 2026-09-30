// Batería de aceptación del paso 6. Requiere la base de datos de desarrollo
// arrancada (npm run bd:dev), migrada y con la semilla cargada.
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { AdaptadorFcm } from './adaptador-fcm.js';
import { AdaptadorNoop } from './adaptador-noop.js';
import { AdaptadorSse, ConexionesSse } from './adaptador-sse.js';
import { DespachadorEventos, EmisorSalida, type Adaptador, type EventoSalida } from './bus.js';

let pool: pg.Pool;
let solicitudId: number;
let dispositivoClienteId: number;

// Adaptador de prueba que registra lo que entrega. Declarado y usado a la
// vista: no finge nada que las aserciones no comprueben.
class AdaptadorMemoria implements Adaptador {
  entregas: EventoSalida[] = [];

  async entregar(evento: EventoSalida): Promise<void> {
    this.entregas.push(evento);
  }
}

class AdaptadorQueFalla implements Adaptador {
  async entregar(evento: EventoSalida): Promise<void> {
    throw new Error(`Fallo simulado entregando el evento ${evento.id}.`);
  }
}

before(async () => {
  pool = crearPool();
  // Una solicitud real como referencia de los eventos de prueba (FK).
  const referencias = await pool.query('SELECT id FROM referencia ORDER BY id LIMIT 2');
  const dispositivo = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES (gen_random_uuid(), 'cliente') RETURNING id`,
  );
  dispositivoClienteId = dispositivo.rows[0].id;
  const solicitud = await pool.query(
    `INSERT INTO solicitud (dispositivo_cliente_id, telefono_cliente, referencia_origen_id,
                            referencia_destino_id, clave_idempotencia)
     VALUES ($1, '+240222999993', $2, $3, $4) RETURNING id`,
    [dispositivoClienteId, referencias.rows[0].id, referencias.rows[1].id, `eventos-${randomUUID()}`],
  );
  solicitudId = solicitud.rows[0].id;
});

after(async () => {
  await pool.end();
});

// Regla de enrutamiento propia de la prueba, con tipo de evento único.
async function crearRegla(canal1: string | null, canal2: string | null = null): Promise<string> {
  const tipo = `PRUEBA_${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO enrutamiento (evento, rol, canal_1, canal_2) VALUES ($1, 'conductor', $2, $3)`,
    [tipo, canal1, canal2],
  );
  return tipo;
}

async function emitir(
  tipo: string,
  datos: Record<string, unknown> = {},
  rol: 'cliente' | 'conductor' = 'conductor',
): Promise<void> {
  const emisor = new EmisorSalida();
  await enTransaccion(pool, (c) => emisor.emitir({
    tipo, rol, solicitudId, dispositivoClienteId, datos,
  }, c));
}

// La misma regla, para el rol del pasajero.
async function crearReglaCliente(canal1: string | null): Promise<string> {
  const tipo = `PRUEBA_${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO enrutamiento (evento, rol, canal_1) VALUES ($1, 'cliente', $2)`,
    [tipo, canal1],
  );
  return tipo;
}

async function filaEvento(tipo: string): Promise<{ intentos: number; ultimo_error: string | null; entregado_en: Date | null; canal_entregado: string | null }> {
  const res = await pool.query(
    'SELECT intentos, ultimo_error, entregado_en, canal_entregado FROM evento_salida WHERE tipo = $1 ORDER BY id DESC LIMIT 1',
    [tipo],
  );
  return res.rows[0];
}

test('outbox: el evento vive y muere con su transacción', async () => {
  const emisor = new EmisorSalida();
  const tipo = `PRUEBA_outbox_${randomUUID().slice(0, 8)}`;

  // Transacción que se deshace: el evento no debe existir.
  await assert.rejects(enTransaccion(pool, async (c) => {
    await emisor.emitir({ tipo, rol: 'conductor', solicitudId, datos: {} }, c);
    throw new Error('fallo posterior de la transacción');
  }));
  const trasRollback = await pool.query('SELECT count(*)::int AS n FROM evento_salida WHERE tipo = $1', [tipo]);
  assert.equal(trasRollback.rows[0].n, 0);

  // Transacción confirmada: el evento queda pendiente de entrega.
  await enTransaccion(pool, (c) => emisor.emitir({ tipo, rol: 'conductor', solicitudId, datos: {} }, c));
  const trasCommit = await pool.query(
    'SELECT count(*)::int AS n FROM evento_salida WHERE tipo = $1 AND entregado_en IS NULL',
    [tipo],
  );
  assert.equal(trasCommit.rows[0].n, 1);
});

test('ACEPTACIÓN: cambiar una fila de enrutamiento redirige el evento sin desplegar', async () => {
  const canalA = new AdaptadorMemoria();
  const canalB = new AdaptadorMemoria();
  const despachador = new DespachadorEventos(pool, new Map<string, Adaptador>([
    ['canal_a', canalA],
    ['canal_b', canalB],
  ]));
  const tipo = await crearRegla('canal_a');

  await emitir(tipo, { n: 1 });
  await despachador.procesarPendientes();
  assert.equal(canalA.entregas.length, 1);
  assert.equal(canalB.entregas.length, 0);
  assert.equal((await filaEvento(tipo)).canal_entregado, 'canal_a');

  // El «despliegue» es un UPDATE en la tabla. Mismo proceso, mismos objetos.
  await pool.query(`UPDATE enrutamiento SET canal_1 = 'canal_b' WHERE evento = $1`, [tipo]);

  await emitir(tipo, { n: 2 });
  await despachador.procesarPendientes();
  assert.equal(canalA.entregas.length, 1, 'el canal antiguo no recibe nada más');
  assert.equal(canalB.entregas.length, 1);
  assert.equal(canalB.entregas[0].datos.n, 2);
  assert.equal((await filaEvento(tipo)).canal_entregado, 'canal_b');
});

test('supresión deliberada (caso C1): canal_1 NULL no entrega y queda registrado', async () => {
  const memoria = new AdaptadorMemoria();
  const despachador = new DespachadorEventos(pool, new Map<string, Adaptador>([['canal_a', memoria]]));
  const tipo = await crearRegla(null);

  await emitir(tipo);
  await despachador.procesarPendientes();
  assert.equal(memoria.entregas.length, 0);
  const fila = await filaEvento(tipo);
  assert.equal(fila.canal_entregado, 'suprimido');
  assert.notEqual(fila.entregado_en, null);
});

test('escalada: si canal_1 falla, entrega canal_2', async () => {
  const canalB = new AdaptadorMemoria();
  const despachador = new DespachadorEventos(pool, new Map<string, Adaptador>([
    ['canal_falla', new AdaptadorQueFalla()],
    ['canal_b', canalB],
  ]));
  const tipo = await crearRegla('canal_falla', 'canal_b');

  await emitir(tipo);
  await despachador.procesarPendientes();
  assert.equal(canalB.entregas.length, 1);
  assert.equal((await filaEvento(tipo)).canal_entregado, 'canal_b');
});

test('sin regla de enrutamiento: reintentos con error explícito y abandono al agotarlos', async () => {
  const despachador = new DespachadorEventos(pool, new Map());
  const tipo = `PRUEBA_sin_regla_${randomUUID().slice(0, 8)}`; // sin fila en enrutamiento

  await emitir(tipo);
  await despachador.procesarPendientes();
  let fila = await filaEvento(tipo);
  assert.equal(fila.intentos, 1);
  assert.match(fila.ultimo_error ?? '', /Sin regla de enrutamiento/);
  assert.equal(fila.entregado_en, null);

  // Agota los reintentos (parámetro eventos_max_intentos = 10).
  for (let i = 0; i < 9; i += 1) {
    await despachador.procesarPendientes();
  }
  fila = await filaEvento(tipo);
  assert.equal(fila.canal_entregado, 'abandonado');
  assert.notEqual(fila.entregado_en, null);
});

test('adaptador SSE: entrega a la conexión viva; al PASAJERO sin conexión no es fallo', async () => {
  const conexiones = new ConexionesSse();
  const despachador = new DespachadorEventos(pool, new Map<string, Adaptador>([
    ['sse', new AdaptadorSse(conexiones)],
  ]));

  // Sin conexión y rol pasajero: no es fallo. Su pantalla pregunta el estado
  // cada diez o veinte segundos, así que se enterará sola.
  const tipoCliente = await crearReglaCliente('sse');
  await emitir(tipoCliente, { aviso: 'primero' }, 'cliente');
  await despachador.procesarPendientes();
  assert.equal((await filaEvento(tipoCliente)).canal_entregado, 'sse_sin_conexion');

  const tipo = await crearRegla('sse');

  // Con conexión viva: el dispositivo recibe la carga JSON.
  const recibido: string[] = [];
  const baja = conexiones.suscribir(dispositivoClienteId, (carga) => recibido.push(carga));
  await emitir(tipo, { aviso: 'segundo' });
  await despachador.procesarPendientes();
  baja();

  assert.equal(recibido.length, 1);
  const carga = JSON.parse(recibido[0]);
  assert.equal(carga.tipo, tipo);
  assert.equal(carga.datos.aviso, 'segundo');
  assert.equal((await filaEvento(tipo)).canal_entregado, 'sse');
  assert.equal(conexiones.tieneConexion(dispositivoClienteId), false);
});

test('adaptador FCM sin credenciales: falla ruidosamente al construirse', () => {
  assert.throws(() => new AdaptadorFcm(undefined), /FCM_CREDENCIALES_RUTA/);
});

test('conexiones SSE: da igual que el identificador venga como número o como cadena', () => {
  // PostgreSQL devuelve los `bigint` como cadena. Si una parte del código se
  // suscribe con "2067" y otra entrega a 2067, el Map no los une y el mensaje
  // se pierde en silencio. Pasó de verdad: las llamadas entre pasajero y
  // taxista no sonaban y no había ningún error por ninguna parte.
  const conexiones = new ConexionesSse();
  const recibidos: string[] = [];
  const baja = conexiones.suscribir('2067', (carga) => recibidos.push(carga));

  assert.equal(conexiones.entregarA(2067, 'hola'), 1, 'número contra cadena');
  assert.equal(conexiones.entregarA('2067', 'otra'), 1, 'cadena contra cadena');
  assert.ok(conexiones.tieneConexion(2067));
  assert.deepEqual(recibidos, ['hola', 'otra']);

  baja();
  assert.equal(conexiones.entregarA(2067, 'tarde'), 0, 'tras la baja no queda nada');
  assert.equal(conexiones.tieneConexion('2067'), false);
});

// --- Migración 058: el aviso que suena con la aplicación cerrada -----------

test('al TAXISTA sin conexión viva el evento se escala al canal 2', async () => {
  // La regla que faltaba. Antes, un taxista con el navegador cerrado recibía
  // «sse_sin_conexion» y el bus lo daba por entregado: la carrera le caducaba
  // en veinte segundos sin que la viera nunca. Ahora falta la conexión, falla
  // el canal 1, y el bus escala a la notificación web, que es lo único que
  // suena con la aplicación cerrada.
  const conexiones = new ConexionesSse();
  const entregadosPorWeb: number[] = [];
  const despachador = new DespachadorEventos(pool, new Map<string, Adaptador>([
    ['sse', new AdaptadorSse(conexiones)],
    ['web', {
      async entregar(evento: EventoSalida): Promise<string> {
        entregadosPorWeb.push(Number(evento.id));
        return 'web';
      },
    }],
  ]));
  const tipo = await crearRegla('sse', 'web');

  await emitir(tipo, { aviso: 'carrera' });
  await despachador.procesarPendientes();

  assert.equal(entregadosPorWeb.length, 1, 'la notificación web tenía que recibirlo');
  assert.equal((await filaEvento(tipo)).canal_entregado, 'web');
});

test('con la aplicación abierta, el aviso NO sale por notificación web', async () => {
  // La otra mitad: con la conexión viva no se despierta la pantalla de nadie.
  // Es instantáneo y no gasta datos, y una notificación encima de la propia
  // pantalla que ya lo enseña es ruido.
  const conexiones = new ConexionesSse();
  let porWeb = 0;
  const despachador = new DespachadorEventos(pool, new Map<string, Adaptador>([
    ['sse', new AdaptadorSse(conexiones)],
    ['web', { async entregar(): Promise<string> { porWeb += 1; return 'web'; } }],
  ]));
  const tipo = await crearRegla('sse', 'web');

  const baja = conexiones.suscribir(dispositivoClienteId, () => undefined);
  await emitir(tipo, { aviso: 'carrera' });
  await despachador.procesarPendientes();
  baja();

  assert.equal(porWeb, 0);
  assert.equal((await filaEvento(tipo)).canal_entregado, 'sse');
});

test('con la aplicación abierta PERO en segundo plano, sí sale la notificación', async () => {
  // El agujero que se vio en producción (29/09): 32 de 33 carreras se dieron
  // por entregadas «por la conexión abierta», así que la notificación que sí
  // suena no se usó ni una vez. Y es que tener la aplicación abierta NO es
  // enterarse: con el teléfono bloqueado en el bolsillo el aviso llega por el
  // socket y no lo ve nadie —no sale notificación del sistema, y el sonido de
  // la página lo puede callar el navegador al ralentizar la pestaña—.
  //
  // Ahora lo que decide no es tener conexión, es que haya alguien mirando.
  const conexiones = new ConexionesSse();
  let porWeb = 0;
  const despachador = new DespachadorEventos(pool, new Map<string, Adaptador>([
    ['sse', new AdaptadorSse(conexiones)],
    ['web', { async entregar(): Promise<string> { porWeb += 1; return 'web'; } }],
  ]));
  const tipo = await crearRegla('sse', 'web');

  const recibido: string[] = [];
  const baja = conexiones.suscribir(dispositivoClienteId, (c) => recibido.push(c));
  // La pantalla avisa de que se ha ido a segundo plano.
  conexiones.marcarVisibilidad(dispositivoClienteId, false);
  await emitir(tipo, { aviso: 'carrera' });
  await despachador.procesarPendientes();
  baja();

  assert.equal(porWeb, 1, 'con nadie mirando, tiene que despertar el teléfono');
  assert.equal((await filaEvento(tipo)).canal_entregado, 'web');
  // Y por el socket se manda igual: si la pestaña vuelve, ya lo tiene.
  assert.equal(recibido.length, 1, 'el dato se entrega igual por la conexión');
});

test('al volver a primer plano se deja de despertar el teléfono', async () => {
  const conexiones = new ConexionesSse();
  let porWeb = 0;
  const despachador = new DespachadorEventos(pool, new Map<string, Adaptador>([
    ['sse', new AdaptadorSse(conexiones)],
    ['web', { async entregar(): Promise<string> { porWeb += 1; return 'web'; } }],
  ]));
  const tipo = await crearRegla('sse', 'web');

  const baja = conexiones.suscribir(dispositivoClienteId, () => undefined);
  conexiones.marcarVisibilidad(dispositivoClienteId, false);
  conexiones.marcarVisibilidad(dispositivoClienteId, true);
  await emitir(tipo, { aviso: 'carrera' });
  await despachador.procesarPendientes();
  baja();

  assert.equal(porWeb, 0);
  assert.equal((await filaEvento(tipo)).canal_entregado, 'sse');
});

test('el «estoy mirando» caduca solo si la pantalla deja de repetirlo', async () => {
  // Es la parte que hace que esto no dependa de que llegue ninguna despedida.
  // Cuando el teléfono se bloquea, el navegador puede congelar la página antes
  // de mandar el «me voy», y sin caducidad el servidor se quedaría creyendo
  // para siempre que hay alguien delante — y no mandaría la notificación, que
  // es justo el fallo que se vino a arreglar.
  const conexiones = new ConexionesSse();
  const baja = conexiones.suscribir(dispositivoClienteId, () => undefined);
  const ahora = Date.now();

  assert.equal(conexiones.hayAlguienMirando(dispositivoClienteId, ahora), true);
  // Un minuto después sin decir nada: todavía vale, para no dejar de sonar por
  // dos peticiones perdidas con mala cobertura.
  assert.equal(conexiones.hayAlguienMirando(dispositivoClienteId, ahora + 60_000), true);
  // Pasados los noventa segundos, ya no.
  assert.equal(conexiones.hayAlguienMirando(dispositivoClienteId, ahora + 95_000), false);

  // Y repetirlo lo renueva.
  conexiones.marcarVisibilidad(dispositivoClienteId, true, ahora + 60_000);
  assert.equal(conexiones.hayAlguienMirando(dispositivoClienteId, ahora + 95_000), true);
  baja();
});

test('la carrera llega a TODAS las pantallas del taxista, no solo a la última', async () => {
  // El agujero que se vio el 30/09: se cogía el dispositivo del último latido.
  // Un taxista con el panel abierto en el ordenador y el móvil bloqueado
  // recibía la carrera en el ordenador —que late porque está abierto— y en el
  // teléfono no pasaba nada, ni por la conexión ni por notificación.
  //
  // El envío de notificaciones ya mandaba a todos sus dispositivos y lo decía
  // en su comentario; esta vía hacía lo contrario. Ahora dicen lo mismo.
  const conductor = await pool.query(
    `INSERT INTO conductor (telefono, nombre) VALUES ($1, 'Taxi Dos Pantallas') RETURNING id`,
    [`+2406${BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 12)}`) % 100_000_000n}`.padEnd(13, '0')],
  );
  const conductorId = Number(conductor.rows[0].id);
  // El del ordenador late ahora; el del teléfono, hace un rato.
  const ordenador = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id, ultimo_heartbeat)
     VALUES (gen_random_uuid(), 'conductor', $1, now()) RETURNING id`,
    [conductorId],
  );
  const telefono = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id, ultimo_heartbeat)
     VALUES (gen_random_uuid(), 'conductor', $1, now() - interval '5 minutes') RETURNING id`,
    [conductorId],
  );

  const conexiones = new ConexionesSse();
  const despachador = new DespachadorEventos(pool, new Map<string, Adaptador>([
    ['sse', new AdaptadorSse(conexiones)],
  ]));
  const tipo = await crearRegla('sse');

  const enOrdenador: string[] = [];
  const enTelefono: string[] = [];
  const baja1 = conexiones.suscribir(Number(ordenador.rows[0].id), (c) => enOrdenador.push(c));
  const baja2 = conexiones.suscribir(Number(telefono.rows[0].id), (c) => enTelefono.push(c));

  const emisor = new EmisorSalida();
  await enTransaccion(pool, (c) => emisor.emitir({
    tipo, rol: 'conductor', solicitudId, conductorId, datos: { aviso: 'carrera' },
  }, c));
  await despachador.procesarPendientes();
  baja1();
  baja2();

  assert.equal(enOrdenador.length, 1, 'el ordenador tiene que recibirla');
  assert.equal(enTelefono.length, 1, 'y el teléfono TAMBIÉN, aunque late más tarde');
  assert.equal((await filaEvento(tipo)).canal_entregado, 'sse');

  await pool.query('DELETE FROM evento_salida WHERE conductor_id = $1', [conductorId]);
  await pool.query('DELETE FROM dispositivo WHERE conductor_id = $1', [conductorId]);
  await pool.query('DELETE FROM conductor WHERE id = $1', [conductorId]);
});

test('una conexión recién abierta cuenta como mirando', async () => {
  // Importa para no estropear lo que ya funcionaba: si un cliente viejo nunca
  // dice si está mirando, se comporta como antes de todo esto. Equivocarse por
  // ahí cuesta un aviso de menos, no uno de más.
  const conexiones = new ConexionesSse();
  const baja = conexiones.suscribir(dispositivoClienteId, () => undefined);
  assert.equal(conexiones.hayAlguienMirando(dispositivoClienteId), true);
  baja();
  assert.equal(conexiones.hayAlguienMirando(dispositivoClienteId), false);
});

test('sin canal 2, al taxista desconectado no se le reintenta diez veces', async () => {
  // El saldo bajo o el viaje cerrado no tienen a dónde escalar. Con la
  // aplicación cerrada, no llegar no es un fallo: se verán al abrirla. La
  // primera versión de la escalada los reintentaba y los dejaba «abandonado».
  const conexiones = new ConexionesSse();
  const despachador = new DespachadorEventos(pool, new Map<string, Adaptador>([
    ['sse', new AdaptadorSse(conexiones)],
  ]));
  const tipo = await crearRegla('sse');

  await emitir(tipo, { aviso: 'saldo' });
  await despachador.procesarPendientes();
  const fila = await filaEvento(tipo);
  assert.equal(fila.canal_entregado, 'sse_sin_conexion');
  assert.equal(fila.ultimo_error, null);
});
