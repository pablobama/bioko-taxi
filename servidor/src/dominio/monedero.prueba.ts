// Batería de aceptación del paso 3. Requiere la base de datos de desarrollo
// arrancada (npm run bd:dev), migrada y con la semilla cargada.
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { ErrorSaldoInsuficiente } from './errores.js';
import {
  cobrarComision, devolverComision, procesarClienteAusente, recargar,
  registrarApunte, renovarSuscripcion, suscripcionVigente, tieneSaldoParaComision,
} from './monedero.js';


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
let referenciaOrigenId: number;
let referenciaDestinoId: number;

before(async () => {
  pool = crearPool();
  const referencias = await pool.query('SELECT id FROM referencia ORDER BY id LIMIT 2');
  assert.equal(referencias.rowCount, 2, 'Faltan referencias: carga la semilla (npm run bd:semilla)');
  referenciaOrigenId = referencias.rows[0].id;
  referenciaDestinoId = referencias.rows[1].id;
});

after(async () => {
  await pool.end();
});

async function crearConductorPrueba(saldoInicialXaf: number): Promise<number> {
  const conductor = await pool.query(
    `INSERT INTO conductor (telefono, nombre, estado_verificacion)
     VALUES ($1, 'Conductor Monedero', 'verificado') RETURNING id`,
    [telefonoUnico()],
  );
  const conductorId: number = conductor.rows[0].id;
  await pool.query('INSERT INTO monedero (conductor_id) VALUES ($1)', [conductorId]);
  if (saldoInicialXaf > 0) {
    await enTransaccion(pool, (c) =>
      recargar(c, conductorId, saldoInicialXaf, `recarga-prueba-${randomUUID()}`));
  }
  return conductorId;
}

async function crearDispositivoClientePrueba(): Promise<number> {
  const res = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES (gen_random_uuid(), 'cliente') RETURNING id`,
  );
  return res.rows[0].id;
}

// Fabrica directamente una solicitud RECOGIDO con su viaje: las pruebas del
// monedero no necesitan recorrer la máquina de estados (eso es el paso 2).
async function crearViajePrueba(conductorId: number, dispositivoClienteId: number): Promise<number> {
  const solicitud = await pool.query(
    `INSERT INTO solicitud
       (dispositivo_cliente_id, telefono_cliente, referencia_origen_id,
        referencia_destino_id, estado, conductor_id, clave_idempotencia)
     VALUES ($1, '+240222999990', $2, $3, 'RECOGIDO', $4, $5) RETURNING id`,
    [dispositivoClienteId, referenciaOrigenId, referenciaDestinoId, conductorId, `viaje-prueba-${randomUUID()}`],
  );
  const viaje = await pool.query(
    `INSERT INTO viaje (solicitud_id, conductor_id, pin, validado_en)
     VALUES ($1, $2, '1234', now()) RETURNING id`,
    [solicitud.rows[0].id, conductorId],
  );
  return viaje.rows[0].id;
}

async function saldoDe(conductorId: number): Promise<number> {
  const res = await pool.query(
    'SELECT saldo_xaf FROM saldo_monedero WHERE conductor_id = $1',
    [conductorId],
  );
  return Number(res.rows[0].saldo_xaf);
}

test('recarga: sube el saldo y es idempotente', async () => {
  const conductorId = await crearConductorPrueba(0);
  const clave = `recarga-${randomUUID()}`;
  const primera = await enTransaccion(pool, (c) => recargar(c, conductorId, 1000, clave));
  const segunda = await enTransaccion(pool, (c) => recargar(c, conductorId, 1000, clave));
  assert.equal(primera.yaExistia, false);
  assert.equal(segunda.yaExistia, true);
  assert.equal(await saldoDe(conductorId), 1000);
});

test('comisión: baja el saldo y reintentar el cierre no cobra dos veces', async () => {
  const conductorId = await crearConductorPrueba(500);
  const dispositivoId = await crearDispositivoClientePrueba();
  const viajeId = await crearViajePrueba(conductorId, dispositivoId);

  const primera = await enTransaccion(pool, (c) => cobrarComision(c, viajeId));
  const segunda = await enTransaccion(pool, (c) => cobrarComision(c, viajeId));
  assert.equal(primera.yaExistia, false);
  assert.equal(primera.saldoXaf, 400);
  assert.equal(segunda.yaExistia, true);
  assert.equal(await saldoDe(conductorId), 400);

  const apuntes = await pool.query(
    `SELECT count(*)::int AS n FROM apunte WHERE viaje_id = $1 AND tipo = 'comision'`,
    [viajeId],
  );
  assert.equal(apuntes.rows[0].n, 1);
});

test('el monedero jamás queda negativo: cobro sin saldo se rechaza y no deja apunte', async () => {
  const conductorId = await crearConductorPrueba(50); // menos que la comisión de 100
  const dispositivoId = await crearDispositivoClientePrueba();
  const viajeId = await crearViajePrueba(conductorId, dispositivoId);

  await assert.rejects(
    enTransaccion(pool, (c) => cobrarComision(c, viajeId)),
    ErrorSaldoInsuficiente,
  );
  assert.equal(await saldoDe(conductorId), 50);
  const apuntes = await pool.query(
    `SELECT count(*)::int AS n FROM apunte WHERE viaje_id = $1`,
    [viajeId],
  );
  assert.equal(apuntes.rows[0].n, 0);
});

test('ACEPTACIÓN: 50 cobros simultáneos no producen saldo negativo ni apunte duplicado', async () => {
  // Saldo para exactamente 20 comisiones de 100; 50 viajes compiten a la vez.
  const conductorId = await crearConductorPrueba(2000);
  const dispositivoId = await crearDispositivoClientePrueba();
  const viajes: number[] = [];
  for (let i = 0; i < 50; i += 1) {
    viajes.push(await crearViajePrueba(conductorId, dispositivoId));
  }

  const resultados = await Promise.allSettled(
    viajes.map((viajeId) => enTransaccion(pool, (c) => cobrarComision(c, viajeId))),
  );

  const aplicados = resultados.filter((r) => r.status === 'fulfilled').length;
  const rechazados = resultados.filter(
    (r) => r.status === 'rejected' && r.reason instanceof ErrorSaldoInsuficiente,
  ).length;
  assert.equal(aplicados, 20, 'deben aplicarse exactamente 20 cobros');
  assert.equal(rechazados, 30, 'los 30 restantes deben rechazarse por saldo');
  assert.equal(await saldoDe(conductorId), 0);

  const apuntes = await pool.query(
    `SELECT count(*)::int AS n
     FROM apunte a JOIN monedero m ON m.id = a.monedero_id
     WHERE m.conductor_id = $1 AND a.tipo = 'comision'`,
    [conductorId],
  );
  assert.equal(apuntes.rows[0].n, 20);
});

test('concurrencia idempotente: 25 cobros simultáneos del MISMO viaje crean un solo apunte', async () => {
  const conductorId = await crearConductorPrueba(1000);
  const dispositivoId = await crearDispositivoClientePrueba();
  const viajeId = await crearViajePrueba(conductorId, dispositivoId);

  const resultados = await Promise.allSettled(
    Array.from({ length: 25 }, () => enTransaccion(pool, (c) => cobrarComision(c, viajeId))),
  );
  assert.equal(resultados.every((r) => r.status === 'fulfilled'), true);
  assert.equal(await saldoDe(conductorId), 900);

  const apuntes = await pool.query(
    `SELECT count(*)::int AS n FROM apunte WHERE viaje_id = $1 AND tipo = 'comision'`,
    [viajeId],
  );
  assert.equal(apuntes.rows[0].n, 1);
});

test('cliente ausente (R4): strike al dispositivo; al tercero, bloqueo; el monedero no se toca', async () => {
  const conductorId = await crearConductorPrueba(1000);
  const dispositivoId = await crearDispositivoClientePrueba();

  for (let vez = 1; vez <= 3; vez += 1) {
    const viajeId = await crearViajePrueba(conductorId, dispositivoId);
    const resultado = await enTransaccion(pool, (c) =>
      procesarClienteAusente(c, viajeId, false));
    assert.equal(resultado.strikeAplicado, true);
    assert.equal(resultado.strikesActuales, vez);
    assert.equal(resultado.dispositivoBloqueado, vez >= 3);
  }
  // Con suscripción no hay comisión que devolver: el saldo queda intacto.
  assert.equal(await saldoDe(conductorId), 1000);
});

test('cliente ausente con sesión SSE activa: nunca sanción automática, incidencia para revisión', async () => {
  const conductorId = await crearConductorPrueba(1000);
  const dispositivoId = await crearDispositivoClientePrueba();
  const viajeId = await crearViajePrueba(conductorId, dispositivoId);

  const resultado = await enTransaccion(pool, (c) =>
    procesarClienteAusente(c, viajeId, true));
  assert.equal(resultado.strikeAplicado, false);

  const dispositivo = await pool.query('SELECT strikes FROM dispositivo WHERE id = $1', [dispositivoId]);
  assert.equal(dispositivo.rows[0].strikes, 0);
  const incidencias = await pool.query(
    `SELECT count(*)::int AS n FROM incidencia WHERE viaje_id = $1 AND tipo = 'no_presentado_dudoso'`,
    [viajeId],
  );
  assert.equal(incidencias.rows[0].n, 1);
});

test('suscripción: cobra la cuota, extiende desde el vencimiento y respeta el saldo', async () => {
  const conductorId = await crearConductorPrueba(3200); // da para 2 cuotas de 1500
  const t0 = new Date();

  assert.equal(await suscripcionVigente(pool, conductorId, t0), false);
  const primera = await enTransaccion(pool, (c) => renovarSuscripcion(c, conductorId, t0));
  assert.equal(primera.saldoXaf, 1700);
  assert.equal(primera.suscritoHasta.getTime(), t0.getTime() + 7 * 86_400_000);
  assert.equal(await suscripcionVigente(pool, conductorId, t0), true);

  // Renovar antes de tiempo no regala días: extiende desde el vencimiento.
  const segunda = await enTransaccion(pool, (c) => renovarSuscripcion(c, conductorId, t0));
  assert.equal(segunda.saldoXaf, 200);
  assert.equal(segunda.suscritoHasta.getTime(), t0.getTime() + 14 * 86_400_000);

  // Tercera cuota: saldo insuficiente, error y vigencia intacta.
  await assert.rejects(
    enTransaccion(pool, (c) => renovarSuscripcion(c, conductorId, t0)),
    ErrorSaldoInsuficiente,
  );
  const fila = await pool.query('SELECT suscrito_hasta FROM conductor WHERE id = $1', [conductorId]);
  assert.equal(new Date(fila.rows[0].suscrito_hasta).getTime(), t0.getTime() + 14 * 86_400_000);
});

test('devolución sin cobro previo: error ruidoso', async () => {
  const conductorId = await crearConductorPrueba(1000);
  const dispositivoId = await crearDispositivoClientePrueba();
  const viajeId = await crearViajePrueba(conductorId, dispositivoId);
  await assert.rejects(
    enTransaccion(pool, (c) => devolverComision(c, viajeId)),
    /no consta ningún cobro de comisión/,
  );
});

test('filtro de emisión (R5): tieneSaldoParaComision', async () => {
  const con = await crearConductorPrueba(100);
  const sin = await crearConductorPrueba(99);
  assert.equal(await enTransaccion(pool, (c) => tieneSaldoParaComision(c, con)), true);
  assert.equal(await enTransaccion(pool, (c) => tieneSaldoParaComision(c, sin)), false);
});

test('el dinero es entero: un importe decimal se rechaza', async () => {
  const conductorId = await crearConductorPrueba(0);
  await assert.rejects(
    enTransaccion(pool, (c) => registrarApunte(c, {
      conductorId,
      tipo: 'recarga',
      importeXaf: 100.5,
      claveIdempotencia: `decimal-${randomUUID()}`,
    })),
    /entero en XAF/,
  );
});
