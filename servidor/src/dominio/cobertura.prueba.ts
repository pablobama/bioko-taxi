// Pruebas de la cobertura agregada (migración 023): taxis cerca del pasajero
// y demanda por zona del taxista.
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { demandaPorZona, taxisCercaDe } from './cobertura.js';
import { crearZona, declararAdyacencia, guardarReferencia } from './gazetteer.js';

let pool: pg.Pool;

before(() => {
  pool = crearPool();
});

after(async () => {
  await pool.end();
});

interface Escenario {
  zonaId: number;
  vecinaId: number;
  origenId: number;
  destinoId: number;
}

async function crearEscenario(): Promise<Escenario> {
  return enTransaccion(pool, async (c) => {
    const { zonaId } = await crearZona(c, `Zona COB ${randomUUID()}`, 3.75, 8.78);
    const { zonaId: vecinaId } = await crearZona(c, `Zona COB vecina ${randomUUID()}`, 3.752, 8.782);
    await declararAdyacencia(c, zonaId, vecinaId);
    const { referenciaId: origenId } = await guardarReferencia(c, {
      zonaId, nombre: 'Origen COB', lat: 3.75, lng: 8.78,
    });
    const { referenciaId: destinoId } = await guardarReferencia(c, {
      zonaId, nombre: 'Destino COB', lat: 3.751, lng: 8.781,
    });
    return { zonaId, vecinaId, origenId, destinoId };
  });
}

// Un taxi con todo en regla y en servicio en la zona pedida. Las variantes
// sirven para comprobar que cada filtro del reparto se respeta también aquí.
async function crearTaxi(zonaId: number, opciones: {
  verificado?: boolean;
  suscrito?: boolean;
  heartbeatVivo?: boolean;
  estado?: string;
  conVehiculo?: boolean;
} = {}): Promise<number> {
  const {
    verificado = true, suscrito = true, heartbeatVivo = true,
    estado = 'DISPONIBLE', conVehiculo = true,
  } = opciones;
  return enTransaccion(pool, async (c) => {
    const conductor = await c.query(
      `INSERT INTO conductor (telefono, nombre, estado_verificacion, suscrito_hasta)
       VALUES ($1, 'Taxi COB', $2, $3) RETURNING id`,
      [
        `+2402227${Date.now()}${Math.floor(Math.random() * 10000)}`,
        verificado ? 'verificado' : 'pendiente',
        suscrito ? new Date(Date.now() + 86_400_000) : new Date(Date.now() - 86_400_000),
      ],
    );
    const conductorId: number = conductor.rows[0].id;
    if (conVehiculo) {
      await c.query(
        `INSERT INTO vehiculo (conductor_id, matricula, marca) VALUES ($1, $2, 'Toyota')`,
        [conductorId, `GE-COB${Date.now()}${Math.floor(Math.random() * 10000)}`],
      );
    }
    await c.query('INSERT INTO monedero (conductor_id) VALUES ($1)', [conductorId]);
    await c.query(
      `INSERT INTO presencia (conductor_id, zona_id, estado, ultimo_heartbeat)
       VALUES ($1, $2, $3, $4)`,
      [
        conductorId, zonaId, estado,
        heartbeatVivo ? new Date() : new Date(Date.now() - 3_600_000),
      ],
    );
    return conductorId;
  });
}

test('taxis cerca: cuenta los de la zona y los de la vecina, porque hasta ahí llega el reparto', async () => {
  const { zonaId, vecinaId, origenId } = await crearEscenario();

  const vacio = await taxisCercaDe(pool, origenId);
  assert.equal(vacio?.disponibles, 0, 'sin taxis se dice cero, no se calla');
  assert.equal(vacio?.zona.startsWith('Zona COB'), true, 'nombra la zona para poder contestar');

  await crearTaxi(zonaId);
  await crearTaxi(zonaId);
  await crearTaxi(vecinaId);

  const cerca = await taxisCercaDe(pool, origenId);
  assert.equal(cerca?.disponibles, 3, 'los tres pueden recibir la carrera');
  assert.equal(cerca?.enTuZona, 2, 'dos están en su propio barrio');
  // La marca de tiempo existe para poder decir si el número es de ahora: sin
  // ella, un conteo viejo se enseñaría como si fuera actual.
  assert.ok(Date.now() - new Date(cerca!.contadoEn).getTime() < 5000);
});

test('taxis cerca: NO cuenta los que el reparto descartaría — nada de taxis fantasma', async () => {
  const { zonaId, origenId } = await crearEscenario();

  // Uno de cada motivo real de descarte en despacho.ts.
  await crearTaxi(zonaId, { verificado: false });
  await crearTaxi(zonaId, { suscrito: false });
  await crearTaxi(zonaId, { heartbeatVivo: false });
  await crearTaxi(zonaId, { estado: 'DESCONECTADO' });
  await crearTaxi(zonaId, { estado: 'OCUPADO' });
  await crearTaxi(zonaId, { conVehiculo: false });

  const cerca = await taxisCercaDe(pool, origenId);
  assert.equal(
    cerca?.disponibles, 0,
    'prometer un taxi que el reparto va a descartar es peor que decir «ahora no hay»',
  );
});

test('taxis cerca: un taxi OFERTADO cuenta, porque es el criterio con el que el sistema decide si busca', async () => {
  const { zonaId, origenId } = await crearEscenario();
  await crearTaxi(zonaId, { estado: 'OFERTADO' });

  const cerca = await taxisCercaDe(pool, origenId);
  // Igual que `hayConductoresVivos()` en despacho.ts: está conectado y puede
  // quedar libre dentro de la ventana de 90 s. Si no contara, el conteo diría
  // «no hay taxi» y acto seguido el sistema se pondría a buscar, desmintiendo
  // a la pantalla delante del pasajero.
  assert.equal(cerca?.disponibles, 1);
});

test('taxis cerca: un taxi con el coche lleno no cuenta, con plaza libre sí (taxi compartido)', async () => {
  const { zonaId, origenId, destinoId } = await crearEscenario();
  const conductorId = await crearTaxi(zonaId);

  const plazas = await pool.query(
    'SELECT plazas FROM vehiculo WHERE conductor_id = $1',
    [conductorId],
  );
  const libres: number = plazas.rows[0].plazas;
  assert.ok(libres >= 1);

  // Con una plaza ocupada de cuatro sigue pudiendo recoger a alguien más.
  await enTransaccion(pool, async (c) => {
    const d = await c.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES ($1, 'cliente') RETURNING id`,
      [randomUUID()],
    );
    await c.query(
      `INSERT INTO solicitud (dispositivo_cliente_id, telefono_cliente,
         referencia_origen_id, referencia_destino_id, estado, conductor_id, clave_idempotencia)
       VALUES ($1, '+240222000333', $2, $3, 'RECOGIDO', $4, $5)`,
      [d.rows[0].id, origenId, destinoId, conductorId, randomUUID()],
    );
  });
  const conUno = await taxisCercaDe(pool, origenId);
  assert.equal(conUno?.disponibles, 1, 'con plazas libres sigue contando');

  // Se le llena el coche: deja de contar.
  await enTransaccion(pool, async (c) => {
    for (let i = 1; i < libres; i += 1) {
      const d = await c.query(
        `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES ($1, 'cliente') RETURNING id`,
        [randomUUID()],
      );
      await c.query(
        `INSERT INTO solicitud (dispositivo_cliente_id, telefono_cliente,
           referencia_origen_id, referencia_destino_id, estado, conductor_id, clave_idempotencia)
         VALUES ($1, '+240222000334', $2, $3, 'RECOGIDO', $4, $5)`,
        [d.rows[0].id, origenId, destinoId, conductorId, randomUUID()],
      );
    }
  });
  const lleno = await taxisCercaDe(pool, origenId);
  assert.equal(lleno?.disponibles, 0, 'con el coche lleno no puede venir a por nadie más');
});

test('taxis cerca: una referencia que no existe no devuelve cero, que se leería como «no hay taxis»', async () => {
  assert.equal(await taxisCercaDe(pool, 0), null);
});

test('demanda por zona: agrupa, ordena por carreras perdidas y calla las zonas por debajo del umbral', async () => {
  const floja = await crearEscenario();
  const fuerte = await crearEscenario();

  const minimo = Number(
    (await pool.query(`SELECT valor FROM parametro WHERE clave = 'demanda_minima_zona'`)).rows[0].valor,
  );

  async function pedir(e: Escenario, cuantas: number, estado: string): Promise<void> {
    await enTransaccion(pool, async (c) => {
      const d = await c.query(
        `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES ($1, 'cliente') RETURNING id`,
        [randomUUID()],
      );
      for (let i = 0; i < cuantas; i += 1) {
        await c.query(
          `INSERT INTO solicitud (dispositivo_cliente_id, telefono_cliente,
             referencia_origen_id, referencia_destino_id, estado, clave_idempotencia)
           VALUES ($1, '+240222000444', $2, $3, $4, $5)`,
          [d.rows[0].id, e.origenId, e.destinoId, estado, randomUUID()],
        );
      }
    });
  }

  // Justo por debajo del umbral: no se nombra. Con una sola solicitud, decir
  // «en este barrio hay demanda» casi señala a quien la pidió.
  await pedir(floja, minimo - 1, 'SIN_OFERTA');
  // Por encima, y todas perdidas: es donde se está dejando dinero.
  await pedir(fuerte, minimo + 2, 'SIN_OFERTA');
  await crearTaxi(fuerte.zonaId);

  const { zonas, ventanaMin } = await demandaPorZona(pool, 50);
  assert.ok(ventanaMin > 0, 'se dice de cuántos minutos habla el dato');

  const nombreFloja = (await pool.query('SELECT nombre FROM zona WHERE id = $1', [floja.zonaId])).rows[0].nombre;
  const nombreFuerte = (await pool.query('SELECT nombre FROM zona WHERE id = $1', [fuerte.zonaId])).rows[0].nombre;

  assert.ok(
    !zonas.some((z) => z.zona === nombreFloja),
    `una zona con ${minimo - 1} solicitudes no se nombra (umbral ${minimo})`,
  );
  const caliente = zonas.find((z) => z.zona === nombreFuerte);
  assert.ok(caliente, 'la zona por encima del umbral sí se nombra');
  assert.equal(caliente!.pedidas, minimo + 2);
  assert.equal(caliente!.sinTaxi, minimo + 2, 'todas se quedaron sin taxi');
  assert.equal(caliente!.taxisAhora, 1, 'y se dice cuántos taxis hay ahí ahora');

  // El orden es lo que hace útil la lista: primero donde se pierden carreras.
  const perdidas = zonas.map((z) => z.sinTaxi);
  assert.deepEqual(
    perdidas, [...perdidas].sort((a, b) => b - a),
    'la lista va de más a menos carreras perdidas',
  );
});

test('demanda por zona: las solicitudes viejas no cuentan, para no mandar al taxista a una zona que ya se vació', async () => {
  const e = await crearEscenario();
  const ventanaMin = Number(
    (await pool.query(`SELECT valor FROM parametro WHERE clave = 'demanda_ventana_min'`)).rows[0].valor,
  );
  const minimo = Number(
    (await pool.query(`SELECT valor FROM parametro WHERE clave = 'demanda_minima_zona'`)).rows[0].valor,
  );

  // Suficientes para superar el umbral, pero todas fuera de la ventana.
  await enTransaccion(pool, async (c) => {
    const d = await c.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES ($1, 'cliente') RETURNING id`,
      [randomUUID()],
    );
    for (let i = 0; i < minimo + 2; i += 1) {
      await c.query(
        `INSERT INTO solicitud (dispositivo_cliente_id, telefono_cliente,
           referencia_origen_id, referencia_destino_id, estado, clave_idempotencia, creada_en)
         VALUES ($1, '+240222000555', $2, $3, 'SIN_OFERTA', $4,
                 now() - make_interval(mins => $5))`,
        [d.rows[0].id, e.origenId, e.destinoId, randomUUID(), ventanaMin + 10],
      );
    }
  });

  const nombre = (await pool.query('SELECT nombre FROM zona WHERE id = $1', [e.zonaId])).rows[0].nombre;
  const { zonas } = await demandaPorZona(pool, 50);
  assert.ok(
    !zonas.some((z) => z.zona === nombre),
    'la demanda de hace una hora no es demanda de ahora',
  );
});
