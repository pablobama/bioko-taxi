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

async function emitir(tipo: string, datos: Record<string, unknown> = {}): Promise<void> {
  const emisor = new EmisorSalida();
  await enTransaccion(pool, (c) => emisor.emitir({
    tipo, rol: 'conductor', solicitudId, dispositivoClienteId, datos,
  }, c));
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

test('adaptador SSE: entrega a la conexión viva; sin conexión queda «sse_sin_conexion»', async () => {
  const conexiones = new ConexionesSse();
  const despachador = new DespachadorEventos(pool, new Map<string, Adaptador>([
    ['sse', new AdaptadorSse(conexiones)],
  ]));
  const tipo = await crearRegla('sse');

  // Sin conexión: no es fallo, queda registrado como sin conexión.
  await emitir(tipo, { aviso: 'primero' });
  await despachador.procesarPendientes();
  assert.equal((await filaEvento(tipo)).canal_entregado, 'sse_sin_conexion');

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
