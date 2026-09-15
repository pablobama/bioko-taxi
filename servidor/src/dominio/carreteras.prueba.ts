// El recorrido por las calles de verdad (diagnóstico del 15/09).
//
// Contra el plano real de Malabo y con el enrutador real: si alguien recompila
// el plano o toca el emparejado, lo que se rompa se ve aquí.
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import { calcularRuta, cargarPlano, type Punto } from '../../../pwa/src/rutas.js';
import { caminoPorCarretera } from './carreteras.js';
import { distanciaMetros } from './geo.js';
import { recorridoDe, registrarRastro } from './rastro.js';

let pool: pg.Pool;
before(() => {
  pool = crearPool();
  cargarPlano(JSON.parse(readFileSync(new URL('../../../pwa/src/mapa-malabo.json', import.meta.url), 'utf8')));
});
after(async () => { await pool.end(); });

let siguienteTelefono = Math.floor(Math.random() * 100_000_000);
async function conductorEnServicio(): Promise<number> {
  siguienteTelefono = (siguienteTelefono + 1) % 100_000_000;
  return enTransaccion(pool, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO conductor (telefono, nombre) VALUES ($1, 'Calles') RETURNING id`,
      [`+2406${String(siguienteTelefono).padStart(8, '0')}`],
    );
    await c.query(
      `INSERT INTO presencia (conductor_id, estado, ultimo_heartbeat) VALUES ($1, 'DISPONIBLE', now())`,
      [rows[0].id],
    );
    return Number(rows[0].id);
  });
}

const largo = (linea: Punto[]) => linea.reduce(
  (m, p, i) => (i === 0 ? 0 : m + distanciaMetros(linea[i - 1].lat, linea[i - 1].lng, p.lat, p.lng)), 0,
);

// Un punto de la ruta a `m` metros del principio.
function enLaRuta(linea: Punto[], m: number): Punto {
  let andado = 0;
  for (let i = 1; i < linea.length; i += 1) {
    const d = distanciaMetros(linea[i - 1].lat, linea[i - 1].lng, linea[i].lat, linea[i].lng);
    if (andado + d >= m) {
      const f = (m - andado) / d;
      return {
        lat: linea[i - 1].lat + f * (linea[i].lat - linea[i - 1].lat),
        lng: linea[i - 1].lng + f * (linea[i].lng - linea[i - 1].lng),
      };
    }
    andado += d;
  }
  return linea[linea.length - 1];
}

test('los kilómetros siguen las calles: un punto por minuto ya no se come las esquinas', async () => {
  // Mercado Central → Semu → Hospital: kilómetro y medio de cuadrícula.
  const tramos = [
    await calcularRuta({ lat: 3.7531, lng: 8.7752 }, { lat: 3.7580, lng: 8.7660 }),
    await calcularRuta({ lat: 3.7580, lng: 8.7660 }, { lat: 3.7508, lng: 8.7711 }),
  ];
  const linea = [...tramos[0]!.puntos, ...tramos[1]!.puntos.slice(1)];
  const total = largo(linea);

  // A 30 km/h, un punto por minuto: 500 m de calle entre uno y otro, que es lo
  // que guarda el sistema de verdad.
  const id = await conductorEnServicio();
  const inicio = new Date('2026-08-21T08:00:00Z');
  const pasoM = (30 / 3.6) * 60;
  let m = 0;
  let t = 0;
  while (m <= total) {
    const p = enLaRuta(linea, m);
    await enTransaccion(pool, (c) => registrarRastro(c, id, p.lat, p.lng, new Date(inicio.getTime() + t * 1000), 5));
    m += pasoM;
    t += 60;
  }
  const ultimo = enLaRuta(linea, total);
  await enTransaccion(pool, (c) => registrarRastro(c, id, ultimo.lat, ultimo.lng, new Date(inicio.getTime() + t * 1000), 5));

  // Recta entre los mismos puntos: lo que contaba el sistema antes.
  const guardados = (await pool.query(
    'SELECT lat, lng FROM rastro WHERE conductor_id = $1 ORDER BY creado_en', [id],
  )).rows.map((f) => ({ lat: Number(f.lat), lng: Number(f.lng) }));
  const enRecta = largo(guardados);

  const r = await recorridoDe(pool, id, new Date(inicio.getTime() - 60_000), new Date(inicio.getTime() + 3_600_000));
  assert.ok(enRecta < total * 0.9, `el caso tiene que tener esquinas que comerse (recta ${enRecta.toFixed(0)} de ${total.toFixed(0)} m)`);
  assert.ok(
    Math.abs(r.metros - total) / total < 0.1,
    `por calles tiene que dar la distancia de la ruta: ${r.metros} m de ${total.toFixed(0)} (en recta eran ${enRecta.toFixed(0)})`,
  );
});

test('el dibujo del recorrido va por las calles, no atraviesa manzanas', async () => {
  // Mercado Central → Semu → Hospital: la cuadrícula del centro, con esquinas
  // de sobra para que una recta cada 450 m se salga de las calles. (Una
  // primera versión usaba Semu → Catedral, casi recta: pasaba igual con el
  // código viejo y no demostraba nada.)
  const a = await calcularRuta({ lat: 3.7531, lng: 8.7752 }, { lat: 3.7580, lng: 8.7660 });
  const b = await calcularRuta({ lat: 3.7580, lng: 8.7660 }, { lat: 3.7508, lng: 8.7711 });
  // Sin los extremos de cada tramo: son coordenadas de catálogo que caen lejos
  // de cualquier calle y el enrutador las cose con una recta. Un coche
  // circulando nunca deja un punto ahí.
  const linea = [...a!.puntos.slice(1, -1), ...b!.puntos.slice(1, -1)];
  const id = await conductorEnServicio();
  const inicio = new Date('2026-08-22T08:00:00Z');
  for (let k = 0, m = 0; m <= largo(linea); k += 1, m += 450) {
    const p = enLaRuta(linea, m);
    await enTransaccion(pool, (c) => registrarRastro(c, id, p.lat, p.lng, new Date(inicio.getTime() + k * 60_000), 5));
  }
  const r = await recorridoDe(pool, id, new Date(inicio.getTime() - 60_000), new Date(inicio.getTime() + 3_600_000));

  // Se mide LO QUE SE DIBUJA, que son las líneas entre los puntos, cada 10 m.
  // Comprobar solo los vértices no vale: con rectas, los vértices son los
  // puntos guardados y están sobre la calle por construcción; lo que se sale
  // es la línea de en medio. (Así estaba la primera versión, y pasaba con el
  // código viejo.)
  const aLaRuta = (p: Punto) => {
    let mejor = Infinity;
    for (let i = 1; i < linea.length; i += 1) {
      const ax = linea[i - 1].lng, ay = linea[i - 1].lat, bx = linea[i].lng, by = linea[i].lat;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const u = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.lng - ax) * dx + (p.lat - ay) * dy) / l2));
      mejor = Math.min(mejor, distanciaMetros(p.lat, p.lng, ay + u * dy, ax + u * dx));
    }
    return mejor;
  };
  let lejos = 0;
  let total = 0;
  for (const tramo of r.tramos) {
    for (let i = 1; i < tramo.length; i += 1) {
      const a2 = tramo[i - 1], b2 = tramo[i];
      const pasos = Math.max(1, Math.round(distanciaMetros(a2.lat, a2.lng, b2.lat, b2.lng) / 10));
      for (let k = 0; k < pasos; k += 1) {
        const p = { lat: a2.lat + ((b2.lat - a2.lat) * k) / pasos, lng: a2.lng + ((b2.lng - a2.lng) * k) / pasos };
        total += 1;
        if (aLaRuta(p) > 20) lejos += 1;
      }
    }
  }
  assert.ok(lejos / total < 0.05, `${Math.round((100 * lejos) / total)} % del dibujo a más de 20 m de la calle recorrida`);
});

// Las dos calzadas de una avenida, cada una de sentido único, a unos metros una
// de otra. El ruido del GPS dejaba el punto en la calzada contraria a la
// marcha, y el único camino legal era bajar hasta la rotonda y volver: 700 m de
// bucle fantasma en un salto de 170 m, y la calle contada dos veces en el mapa
// de calor. Coordenadas del caso que lo destapó en el diagnóstico.
test('un punto en la calzada contraria de una avenida no inventa una vuelta por la rotonda', () => {
  const desde = { lat: 3.75624, lng: 8.76620 };
  const hasta = { lat: 3.75475, lng: 8.76634 };
  const recta = distanciaMetros(desde.lat, desde.lng, hasta.lat, hasta.lng);
  const camino = caminoPorCarretera(desde, hasta, recta, 100, 180);
  assert.notEqual(camino, null, 'la avenida existe: tiene que haber camino, y directo');
  assert.ok(
    camino!.distanciaM < recta * 1.6,
    `un salto de ${recta.toFixed(0)} m no puede ser un camino de ${camino!.distanciaM.toFixed(0)} m`,
  );
});

test('un camino que no da tiempo a recorrer no se acepta', () => {
  // Diez segundos para ir de Semu al Hospital: no hay coche que lo haga por
  // calles, así que no hay camino creíble y manda la recta.
  const semu = { lat: 3.7580, lng: 8.7660 };
  const hospital = { lat: 3.7508, lng: 8.7711 };
  const recta = distanciaMetros(semu.lat, semu.lng, hospital.lat, hospital.lng);
  assert.equal(caminoPorCarretera(semu, hospital, recta, 10, 180), null);
});
