// Avisar al que se quedó sin taxi cuando entra uno en su barrio (076).
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { anotarEspera, avisarTaxiLibre, dejarDeEsperar, purgarEsperas } from './esperas.js';
import type { EmisorEventos } from './eventos.js';

let pool: pg.Pool;
const zonasInventadas: number[] = [];

before(() => { pool = crearPool(); });
after(async () => {
  if (zonasInventadas.length > 0) {
    await pool.query(
      `DELETE FROM espera_taxi WHERE zona_id = ANY($1)`, [zonasInventadas],
    );
  }
  await pool.end();
});

// Un emisor que solo apunta lo que se le manda: aquí se mide a QUIÉN se avisa,
// no cómo viaja el aviso.
function emisorDePrueba(): EmisorEventos & { emitidos: Array<Record<string, unknown>> } {
  const emitidos: Array<Record<string, unknown>> = [];
  return {
    emitidos,
    async emitir(evento) {
      emitidos.push(evento as unknown as Record<string, unknown>);
    },
  } as EmisorEventos & { emitidos: Array<Record<string, unknown>> };
}

// Una solicitud de verdad en un barrio nuevo, que es lo que hace falta para
// hablar de esperas: quién pidió, y dónde.
async function solicitudSinTaxi(): Promise<{
  solicitudId: number; dispositivoId: number; zonaId: number;
}> {
  return enTransaccion(pool, async (c) => {
    const zona = await c.query(
      `INSERT INTO zona (nombre, distrito, centroide_lat, centroide_lng)
       VALUES ($1, 'Malabo', 3.7530, 8.7750) RETURNING id`,
      [`Zona Espera ${randomUUID()}`],
    );
    const zonaId = Number(zona.rows[0].id);
    zonasInventadas.push(zonaId);
    const ref = await c.query(
      `INSERT INTO referencia (zona_id, nombre, lat, lng)
       VALUES ($1, $2, 3.7531, 8.7752) RETURNING id`,
      [zonaId, `Ref Espera ${randomUUID().slice(0, 8)}`],
    );
    const dispositivo = await c.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo)
       VALUES (gen_random_uuid(), 'cliente') RETURNING id`,
    );
    const solicitud = await c.query(
      `INSERT INTO solicitud (dispositivo_cliente_id, telefono_cliente,
                              referencia_origen_id, referencia_destino_id, clave_idempotencia)
       VALUES ($1, '+240222999993', $2, $2, $3) RETURNING id`,
      [dispositivo.rows[0].id, ref.rows[0].id, `espera-${randomUUID()}`],
    );
    return {
      solicitudId: Number(solicitud.rows[0].id),
      dispositivoId: Number(dispositivo.rows[0].id),
      zonaId,
    };
  });
}

test('al que se quedó sin taxi se le avisa cuando entra uno en SU barrio', async () => {
  const { solicitudId, dispositivoId, zonaId } = await solicitudSinTaxi();
  const emisor = emisorDePrueba();

  await enTransaccion(pool, async (c) => {
    await anotarEspera(c, solicitudId);
    const avisados = await avisarTaxiLibre(c, emisor, zonaId);
    assert.equal(avisados, 1);
  });

  assert.equal(emisor.emitidos.length, 1);
  assert.equal(emisor.emitidos[0].tipo, 'C7_taxi_disponible');
  assert.equal(emisor.emitidos[0].rol, 'cliente');
  assert.equal(emisor.emitidos[0].dispositivoClienteId, dispositivoId);
});

test('al de otro barrio no se le avisa: un taxi al otro lado no le sirve', async () => {
  const propio = await solicitudSinTaxi();
  const ajeno = await solicitudSinTaxi();
  const emisor = emisorDePrueba();

  await enTransaccion(pool, async (c) => {
    await anotarEspera(c, propio.solicitudId);
    await anotarEspera(c, ajeno.solicitudId);
    // Entra un taxi SOLO en el barrio del primero.
    await avisarTaxiLibre(c, emisor, propio.zonaId);
  });

  assert.equal(emisor.emitidos.length, 1);
  assert.equal(emisor.emitidos[0].dispositivoClienteId, propio.dispositivoId);
});

test('se avisa UNA vez: el segundo taxista no es una noticia nueva', async () => {
  // Lo que se le está diciendo es «ya hay taxis», no «ha entrado alguien». Sin
  // esto, un barrio donde entran cinco taxistas seguidos le haría sonar el
  // teléfono cinco veces a la misma persona, y eso es justo lo que hace que se
  // apaguen los avisos.
  const { solicitudId, zonaId } = await solicitudSinTaxi();
  const emisor = emisorDePrueba();

  await enTransaccion(pool, async (c) => {
    await anotarEspera(c, solicitudId);
    assert.equal(await avisarTaxiLibre(c, emisor, zonaId), 1);
    assert.equal(await avisarTaxiLibre(c, emisor, zonaId), 0, 'el segundo no vuelve a sonar');
    assert.equal(await avisarTaxiLibre(c, emisor, zonaId), 0);
  });
  assert.equal(emisor.emitidos.length, 1);
});

test('una espera vencida ya no avisa, y se borra sola', async () => {
  // Un aviso que llega tarde es peor que ninguno: manda a la calle a alguien
  // que hace media hora que resolvió lo suyo.
  const { solicitudId, zonaId } = await solicitudSinTaxi();
  const emisor = emisorDePrueba();
  const hace = new Date(Date.now() - 3 * 3600_000);

  await enTransaccion(pool, async (c) => {
    await anotarEspera(c, solicitudId, hace);
    assert.equal(await avisarTaxiLibre(c, emisor, zonaId), 0, 'caducada: no se avisa');
  });
  assert.equal(emisor.emitidos.length, 0);

  assert.ok(await purgarEsperas(pool) >= 1);
  const quedan = await pool.query(
    'SELECT count(*)::int n FROM espera_taxi WHERE zona_id = $1', [zonaId],
  );
  assert.equal(quedan.rows[0].n, 0);
});

test('quien consigue taxi deja de esperar', async () => {
  // Si no, seguiría recibiendo el aviso de que «ya hay taxis» mientras va
  // montado en uno.
  const { solicitudId, dispositivoId, zonaId } = await solicitudSinTaxi();
  const emisor = emisorDePrueba();

  await enTransaccion(pool, async (c) => {
    await anotarEspera(c, solicitudId);
    await dejarDeEsperar(c, dispositivoId);
    assert.equal(await avisarTaxiLibre(c, emisor, zonaId), 0);
  });
  assert.equal(emisor.emitidos.length, 0);
});

test('volver a quedarse sin taxi pone el reloj a cero y se puede volver a avisar', async () => {
  const { solicitudId, zonaId } = await solicitudSinTaxi();
  const emisor = emisorDePrueba();

  await enTransaccion(pool, async (c) => {
    await anotarEspera(c, solicitudId);
    await avisarTaxiLibre(c, emisor, zonaId);
    // Pide otra vez y vuelve a quedarse sin taxi: es una espera nueva, no la
    // de antes, y merece su aviso.
    await anotarEspera(c, solicitudId);
    assert.equal(await avisarTaxiLibre(c, emisor, zonaId), 1);
  });
  assert.equal(emisor.emitidos.length, 2);
});
