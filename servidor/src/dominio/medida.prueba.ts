// Medir un viaje por el rastro y no por los botones (29/09).
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { medirViaje } from './medida.js';
import {
  duplicadasCerca, fueraDeSitio, paresImposibles, METROS_DEL_BARRIO,
} from './referencias.js';

let pool: pg.Pool;
const inventados: number[] = [];

before(() => { pool = crearPool(); });
after(async () => {
  // La base de desarrollo la comparten todas las baterías: lo que se inventa
  // aquí se recoge, o se acumula una tanda más en cada pasada.
  if (inventados.length > 0) {
    await pool.query('DELETE FROM rastro WHERE conductor_id = ANY($1)', [inventados]);
    await pool.query('DELETE FROM presencia WHERE conductor_id = ANY($1)', [inventados]);
    await pool.query('DELETE FROM conductor WHERE id = ANY($1)', [inventados]);
  }
  await pool.end();
});

const ORIGEN = { lat: 3.7531, lng: 8.7752 };
const DESTINO = { lat: 3.7625, lng: 8.7840 };
// A un kilómetro largo de los dos: por aquí se pasa, pero no se sale ni se
// llega.
const ENMEDIO = { lat: 3.7580, lng: 8.7795 };

async function taxista(): Promise<number> {
  return enTransaccion(pool, async (c) => {
    const telefono = `+2406${BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 12)}`) % 100_000_000n}`
      .padEnd(13, '0');
    const r = await c.query(
      `INSERT INTO conductor (telefono, nombre) VALUES ($1, 'Taxi Medida') RETURNING id`,
      [telefono],
    );
    const id = Number(r.rows[0].id);
    inventados.push(id);
    return id;
  });
}

async function anotar(
  conductorId: number,
  puntos: Array<{ lat: number; lng: number; min: number }>,
  base: Date,
): Promise<void> {
  await enTransaccion(pool, async (c) => {
    for (const p of puntos) {
      await c.query(
        'INSERT INTO rastro (conductor_id, lat, lng, creado_en) VALUES ($1, $2, $3, $4)',
        [conductorId, p.lat, p.lng, new Date(base.getTime() + p.min * 60_000)],
      );
    }
  });
}

test('el viaje dura lo que dice el rastro, no lo que dicen los botones', async () => {
  // El caso de producción: el taxista pulsa «recoger» y «terminado» casi a la
  // vez —porque está generando recorridos para medir— y el viaje consta de 30
  // segundos. El coche, mientras, tardó doce minutos en ir de un sitio a otro.
  const conductor = await taxista();
  const base = new Date(Date.now() - 2 * 3600_000);
  await anotar(conductor, [
    { ...ORIGEN, min: 0 },
    { ...ORIGEN, min: 2 },     // esperando en el origen
    { ...ENMEDIO, min: 8 },
    { ...DESTINO, min: 14 },
    { ...DESTINO, min: 20 },   // ya parado en el destino
  ], base);

  const m = await medirViaje(pool, {
    conductorId: conductor,
    origen: ORIGEN,
    destino: DESTINO,
    // Los dos botones, pulsados con medio minuto de diferencia al final.
    recogidoEn: new Date(base.getTime() + 19 * 60_000),
    completadoEn: new Date(base.getTime() + 19.5 * 60_000),
  });

  assert.equal(m.calidad, 'buena');
  // De la ÚLTIMA vez en el origen (minuto 2) a la PRIMERA en el destino (14).
  assert.equal(Math.round(m.minutos!), 12,
    `el coche tardó doce minutos, salió ${m.minutos}`);
  assert.equal(Math.round(m.minutosDeclarados * 10) / 10, 0.5);
  // Y el desfase es la medida del problema: los botones se equivocaron en once
  // minutos y medio.
  assert.ok(m.desfaseMin !== null && m.desfaseMin < -11,
    `el desfase tiene que delatar el cierre (${m.desfaseMin})`);
});

test('que el taxista VUELVA por el origen no invalida el viaje', async () => {
  // El fallo que se vio en producción (30/09): cuatro viajes tenían las dos
  // puntas a menos de cien metros del recorrido y aun así salían como «no se
  // puede medir».
  //
  // La causa era el orden en que se buscaban. Se cogía la última vez junto al
  // origen y luego la primera vez junto al destino DESPUÉS de esa; y como la
  // ventana mira 45 minutos más allá del cierre, un taxista que regresa por el
  // barrio del origen al terminar movía esa «última vez» al final del
  // recorrido, y ya no quedaba ningún paso por el destino detrás.
  const conductor = await taxista();
  const base = new Date(Date.now() - 6 * 3600_000);
  await anotar(conductor, [
    { ...ORIGEN, min: 0 },
    { ...ENMEDIO, min: 5 },
    { ...DESTINO, min: 10 },   // aquí terminó el viaje: diez minutos
    { ...ENMEDIO, min: 15 },
    { ...ORIGEN, min: 20 },    // y volvió por donde vino
    { ...ORIGEN, min: 25 },
  ], base);

  const m = await medirViaje(pool, {
    conductorId: conductor,
    origen: ORIGEN,
    destino: DESTINO,
    recogidoEn: base,
    completadoEn: new Date(base.getTime() + 11 * 60_000),
  });
  assert.equal(m.calidad, 'buena', 'volver al barrio no puede invalidar el viaje');
  assert.equal(Math.round(m.minutos!), 10,
    `el viaje duró diez minutos; lo de después es otra cosa (salió ${m.minutos})`);
});

test('sin rastro no se inventa una duración: se dice que no se sabe', async () => {
  // Es la mitad del arreglo. Un viaje de 6 km «hecho en 30 segundos» metido en
  // una media se lleva por delante el resultado; en producción tres filas así
  // movieron el error medio del tiempo de −0,5 a +8 minutos.
  const conductor = await taxista();
  const base = new Date(Date.now() - 3 * 3600_000);
  const m = await medirViaje(pool, {
    conductorId: conductor,
    origen: ORIGEN,
    destino: DESTINO,
    recogidoEn: base,
    completadoEn: new Date(base.getTime() + 30_000),
  });
  assert.equal(m.calidad, 'sin_rastro');
  assert.equal(m.minutos, null);
  assert.equal(m.desfaseMin, null);
});

test('si el rastro no cubre el viaje entero, tampoco se inventa', async () => {
  // El coche aparece a mitad de camino: se le ve llegar pero no salir. Con eso
  // se puede decir «hay rastro» y nada más.
  const conductor = await taxista();
  const base = new Date(Date.now() - 4 * 3600_000);
  await anotar(conductor, [
    { ...ENMEDIO, min: 0 },
    { ...DESTINO, min: 6 },
  ], base);

  const m = await medirViaje(pool, {
    conductorId: conductor,
    origen: ORIGEN,
    destino: DESTINO,
    recogidoEn: base,
    completadoEn: new Date(base.getTime() + 8 * 60_000),
  });
  assert.equal(m.calidad, 'parcial');
  assert.equal(m.minutos, null);
  assert.ok(m.puntosDeRastro >= 2, 'rastro había, lo que falta es el principio');

  // Y se dice LO MÁS que se acercó a cada punta. Sin eso, «no cubre el viaje»
  // son tres problemas distintos en el mismo saco: un listón demasiado
  // apretado, una referencia mal situada, o un recorrido que no se grabó. Con
  // los metros delante se sabe cuál es.
  assert.ok(m.masCercaDelDestinoM !== null && m.masCercaDelDestinoM < 50,
    `llegó al destino, así que eso tiene que salir cerca (${m.masCercaDelDestinoM} m)`);
  assert.ok(m.masCercaDelOrigenM !== null && m.masCercaDelOrigenM > 200,
    `del origen no se acercó nunca, y eso es lo que hay que poder ver`
    + ` (${m.masCercaDelOrigenM} m)`);
});

test('dar vueltas por el origen antes de cargar no alarga el viaje', async () => {
  const conductor = await taxista();
  const base = new Date(Date.now() - 5 * 3600_000);
  await anotar(conductor, [
    { ...ORIGEN, min: 0 },
    { ...ORIGEN, min: 5 },
    { ...ORIGEN, min: 10 },   // diez minutos esperando a que salga el pasajero
    { ...ENMEDIO, min: 13 },
    { ...DESTINO, min: 17 },
  ], base);

  const m = await medirViaje(pool, {
    conductorId: conductor,
    origen: ORIGEN,
    destino: DESTINO,
    recogidoEn: base,
    completadoEn: new Date(base.getTime() + 18 * 60_000),
  });
  assert.equal(m.calidad, 'buena');
  assert.equal(Math.round(m.minutos!), 7,
    'del último momento en el origen al primero en el destino, no antes');
});

// --- El metro con el que se mide: las referencias -------------------------

test('dos fichas del mismo sitio, pegadas, salen como duplicadas', async () => {
  // El caso real: «Tesorería General del Estado» y «Tesorería General» a 0,1 km.
  const zonaId = await enTransaccion(pool, async (c) => {
    const z = await c.query(
      `INSERT INTO zona (nombre, distrito, centroide_lat, centroide_lng)
       VALUES ($1, 'Malabo', 3.7530, 8.7750) RETURNING id`,
      [`Zona Medida ${randomUUID()}`],
    );
    const zona = z.rows[0].id;
    await c.query(
      `INSERT INTO referencia (zona_id, nombre, lat, lng) VALUES
         ($1, $2, 3.75310, 8.77520),
         ($1, $3, 3.75318, 8.77529),
         ($1, $4, 3.75312, 8.77521)`,
      // Sin sufijo al azar: lo que se está probando es justamente que un
      // nombre esté CONTENIDO en el otro, y un sufijo distinto en cada uno lo
      // rompería. El nombre solo tiene que ser único dentro de esta zona, que
      // es nueva.
      // El nombre corto tiene que estar CONTENIDO en el largo, que es el caso
      // real: «Tesorería General» dentro de «Tesorería General del Estado».
      [zona, 'Tesorería General ZZ',
        'Tesorería General ZZ del Estado', 'Farmacia Central ZZ'],
    );
    return zona;
  });

  // Acotado a su barrio. Si no, esto recorre las 15.948 referencias de la base
  // de desarrollo —miles llamadas «Origen Conductor» en el mismo punto, basura
  // del simulador, que dan siete millones y medio de parejas— y tarda medio
  // minuto en decir algo que se ve en un barrio.
  const { pares, total } = await duplicadasCerca(pool, { zonaId: Number(zonaId) });
  assert.ok(total >= 1);
  const mio = pares.find((p) =>
    [p.a.nombre, p.b.nombre].includes('Tesorería General ZZ del Estado'));
  assert.ok(mio, 'las dos fichas de la Tesorería tienen que salir emparejadas');
  assert.ok(mio!.metros <= 150);

  // Y la farmacia, que está igual de cerca pero no es lo mismo, NO sale: si
  // esto emparejara por cercanía a secas, media ciudad serían duplicados.
  assert.ok(!pares.some((p) => [p.a.nombre, p.b.nombre].includes('Farmacia Central ZZ')),
    'estar al lado no convierte a dos sitios distintos en el mismo');

  await pool.query('DELETE FROM referencia WHERE zona_id = $1', [zonaId]);
  await pool.query('DELETE FROM zona WHERE id = $1', [zonaId]);
});

test('una referencia fuera de la isla se señala sin discusión', async () => {
  const zonaId = await enTransaccion(pool, async (c) => {
    const z = await c.query(
      `INSERT INTO zona (nombre, distrito, centroide_lat, centroide_lng)
       VALUES ($1, 'Malabo', 3.7530, 8.7750) RETURNING id`,
      [`Zona Fuera ${randomUUID()}`],
    );
    const zona = z.rows[0].id;
    await c.query(
      // En el golfo, a cien kilómetros. No hay nada que discutir sobre esto.
      `INSERT INTO referencia (zona_id, nombre, lat, lng) VALUES ($1, $2, 2.90, 9.50)`,
      [zona, `Sitio Imposible ${randomUUID().slice(0, 6)}`],
    );
    return zona;
  });

  const malas = await fueraDeSitio(pool);
  const mia = malas.find((m) => m.nombre.startsWith('Sitio Imposible'));
  assert.ok(mia, 'una referencia en el mar tiene que salir');
  assert.equal(mia!.motivo, 'fuera de la isla');

  await pool.query('DELETE FROM referencia WHERE zona_id = $1', [zonaId]);
  await pool.query('DELETE FROM zona WHERE id = $1', [zonaId]);
});

test('una referencia lejísimos de su barrio también, y se dice cuánto', async () => {
  const zonaId = await enTransaccion(pool, async (c) => {
    const z = await c.query(
      `INSERT INTO zona (nombre, distrito, centroide_lat, centroide_lng)
       VALUES ($1, 'Malabo', 3.7530, 8.7750) RETURNING id`,
      [`Zona Lejos ${randomUUID()}`],
    );
    const zona = z.rows[0].id;
    await c.query(
      // Dentro de la isla, pero en Luba: su barrio está en Malabo.
      `INSERT INTO referencia (zona_id, nombre, lat, lng) VALUES ($1, $2, 3.4560, 8.5560)`,
      [zona, `Sitio Descolocado ${randomUUID().slice(0, 6)}`],
    );
    return zona;
  });

  const malas = await fueraDeSitio(pool);
  const mia = malas.find((m) => m.nombre.startsWith('Sitio Descolocado'));
  assert.ok(mia, 'una referencia de Malabo situada en Luba tiene que salir');
  assert.equal(mia!.motivo, 'lejísimos de su barrio');
  assert.ok(mia!.metrosDelBarrio !== null && mia!.metrosDelBarrio > METROS_DEL_BARRIO);

  await pool.query('DELETE FROM referencia WHERE zona_id = $1', [zonaId]);
  await pool.query('DELETE FROM zona WHERE id = $1', [zonaId]);
});

test('los pares imposibles se listan sin tocar el plano ni el rastro', async () => {
  // «Club Náutico → Ventage Mall: 49,3 km», dos veces, con los dos sitios en
  // Malabo. La recta entre las dos fichas ya es la cota mínima: si en recta son
  // cuarenta kilómetros, no hay ruta ni GPS que lo arregle.
  const pares = await paresImposibles(pool, 20);
  for (const p of pares) {
    assert.ok(p.km > 20, 'solo se listan los que pasan del tope');
    assert.ok(p.viajes >= 1);
  }
  // Ordenados de peor a mejor, para que la lista corta sea la de arriba.
  for (let i = 1; i < pares.length; i += 1) {
    assert.ok(pares[i - 1].km >= pares[i].km, 'de mayor a menor distancia');
  }
});
