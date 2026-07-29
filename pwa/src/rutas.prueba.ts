// Pruebas del cálculo de rutas, contra el plano real de Malabo.
//
// Ejecutar: npm run probar   (desde /pwa)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calcularRuta, cargarPlano } from './rutas.js';

const plano = JSON.parse(
  readFileSync(new URL('./mapa-malabo.json', import.meta.url), 'utf8'),
);
cargarPlano(plano);

// Sitios reales del gazetteer de Malabo.
const MERCADO_CENTRAL = { lat: 3.7531, lng: 8.7752 };
const HOSPITAL = { lat: 3.7508, lng: 8.7711 };
const CATEDRAL = { lat: 3.7539, lng: 8.7737 };
const SEMU = { lat: 3.7580, lng: 8.7660 };

function metrosRectos(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

test('el plano compilado trae calles suficientes para enrutar', () => {
  assert.ok(plano.vias.length > 1000, `solo ${plano.vias.length} vías`);
});

test('la ruta sigue calles: más puntos y más larga que la línea recta', async () => {
  const ruta = await calcularRuta(MERCADO_CENTRAL, HOSPITAL);
  assert.notEqual(ruta, null, 'debería haber camino entre el Mercado Central y el Hospital');

  const recta = metrosRectos(MERCADO_CENTRAL, HOSPITAL);
  assert.ok(ruta!.puntos.length > 5,
    `una ruta por calles tiene muchos vértices, tiene ${ruta!.puntos.length}`);
  assert.ok(ruta!.distanciaM >= recta,
    `por calles (${Math.round(ruta!.distanciaM)} m) no puede ser más corto que en línea recta (${Math.round(recta)} m)`);
  // Un rodeo desmedido delataría un grafo mal conectado.
  assert.ok(ruta!.distanciaM < recta * 3,
    `rodeo excesivo: ${Math.round(ruta!.distanciaM)} m frente a ${Math.round(recta)} m rectos`);
});

test('los extremos de la ruta son exactamente los puntos pedidos', async () => {
  const ruta = await calcularRuta(MERCADO_CENTRAL, CATEDRAL);
  assert.notEqual(ruta, null);
  assert.deepEqual(ruta!.puntos[0], MERCADO_CENTRAL);
  assert.deepEqual(ruta!.puntos[ruta!.puntos.length - 1], CATEDRAL);
});

test('rutas entre zonas distintas también se resuelven', async () => {
  const ruta = await calcularRuta(MERCADO_CENTRAL, SEMU);
  assert.notEqual(ruta, null, 'Malabo Centro y Semu deberían estar conectados por carretera');
  assert.ok(ruta!.puntos.length > 10);
});

test('un punto fuera de Malabo no se enruta: devuelve null en vez de inventarse algo', async () => {
  const enElMar = { lat: 3.60, lng: 8.60 };
  assert.equal(await calcularRuta(MERCADO_CENTRAL, enElMar), null);
});

test('el mismo trayecto siempre da la misma ruta', async () => {
  const a = await calcularRuta(MERCADO_CENTRAL, HOSPITAL);
  const b = await calcularRuta(MERCADO_CENTRAL, HOSPITAL);
  assert.deepEqual(a!.puntos, b!.puntos);
  assert.equal(a!.distanciaM, b!.distanciaM);
});

test('calcular una ruta es rápido: el conductor no puede esperar', async () => {
  const inicio = performance.now();
  for (let i = 0; i < 20; i += 1) {
    await calcularRuta(SEMU, HOSPITAL);
  }
  const porRuta = (performance.now() - inicio) / 20;
  assert.ok(porRuta < 150, `cada ruta tarda ${porRuta.toFixed(0)} ms; demasiado para un móvil lento`);
  console.log(`      (${porRuta.toFixed(1)} ms por ruta)`);
});

// --- Sentidos únicos (plano versión 3) --------------------------------------
//
// Con un plano sintético diminuto: una manzana cuadrada donde el lado A-B es
// de sentido único (solo A→B) y el rodeo A-D-C-B es de doble sentido.
//
//   B ←—— C
//   ↑↕     ↕      A→B: único (la ↑ del lado izquierdo)
//   A ——→ D      resto: ambos sentidos
//
// Cada lado mide ~111 m (0.001° de latitud).
const A = { lat: 3.75, lng: 8.78 };
const B = { lat: 3.751, lng: 8.78 };
const C = { lat: 3.751, lng: 8.781 };
const D = { lat: 3.75, lng: 8.781 };
const aplanar = (...puntos: Array<{ lat: number; lng: number }>) =>
  puntos.flatMap((p) => [p.lat, p.lng]);

test('la ruta respeta un sentido único: a favor va directa, en contra rodea la manzana', async () => {
  try {
    cargarPlano({
      vias: [
        { c: 3, p: aplanar(A, B), s: 1 },
        { c: 3, p: aplanar(A, D, C, B) },
      ],
    });
    const aFavor = await calcularRuta(A, B);
    const enContra = await calcularRuta(B, A);
    assert.notEqual(aFavor, null);
    assert.notEqual(enContra, null);
    // A favor: los ~111 m del lado único. En contra: los ~333 m del rodeo.
    assert.ok(aFavor!.distanciaM < 150, `directa: ${Math.round(aFavor!.distanciaM)} m`);
    assert.ok(enContra!.distanciaM > 300, `el rodeo debe medir ~333 m, mide ${Math.round(enContra!.distanciaM)} m`);
    // Y el rodeo pasa de verdad por la otra esquina de la manzana.
    assert.ok(
      enContra!.puntos.some((p) => Math.abs(p.lat - D.lat) < 1e-9 && Math.abs(p.lng - D.lng) < 1e-9),
      'la ruta en contra debe pasar por D',
    );
  } finally {
    cargarPlano(plano);
  }
});

test('rescate: si el ÚNICO camino va a contramano, se enseña igual antes que nada', async () => {
  try {
    // Solo existe el lado único A→B: de B a A no hay camino legal.
    cargarPlano({ vias: [{ c: 3, p: aplanar(A, B), s: 1 }] });
    const enContra = await calcularRuta(B, A);
    assert.notEqual(enContra, null, 'el reintento sin sentidos debe encontrar el camino');
    assert.ok(enContra!.distanciaM < 150);
  } finally {
    cargarPlano(plano);
  }
});

// --- Más rápido, no más corto ------------------------------------------------

test('la ruta prefiere la avenida aunque el callejón sea más corto', async () => {
  // Directo A→B: callejón de servicio de ~333 m (a 10 km/h, dos minutos).
  // Rodeo A→M1→M2→B: avenidas, ~555 m (a 50 km/h, cuarenta segundos).
  const M1 = { lat: 3.751, lng: 8.78 };
  const M2 = { lat: 3.751, lng: 8.783 };
  const B2 = { lat: 3.75, lng: 8.783 };
  try {
    cargarPlano({
      vias: [
        { c: 4, p: aplanar(A, B2) },
        { c: 1, p: aplanar(A, M1) },
        { c: 1, p: aplanar(M1, M2) },
        { c: 1, p: aplanar(M2, B2) },
      ],
    });
    const ruta = await calcularRuta(A, B2);
    assert.notEqual(ruta, null);
    assert.ok(
      ruta!.puntos.some((p) => Math.abs(p.lat - M1.lat) < 1e-9 && Math.abs(p.lng - M1.lng) < 1e-9),
      'debe rodear por la avenida (pasar por M1), no meterse por el callejón',
    );
    assert.ok(ruta!.distanciaM > 500, `el rodeo mide ~555 m, midió ${Math.round(ruta!.distanciaM)}`);
  } finally {
    cargarPlano(plano);
  }
});

test('los extremos se enganchan al punto de la calle, no al cruce más cercano', async () => {
  // Una única calle recta de ~333 m. La persona está a 11 m de un punto
  // situado a un TERCIO de la calle: la ruta debe salir de ahí (~233 m hasta
  // el final), no del cruce inicial (que daría ~444 m con el enganche).
  const N1 = { lat: 3.75, lng: 8.78 };
  const N2 = { lat: 3.75, lng: 8.783 };
  const cerca = { lat: 3.7501, lng: 8.781 };
  try {
    cargarPlano({ vias: [{ c: 3, p: aplanar(N1, N2) }] });
    const ruta = await calcularRuta(cerca, N2);
    assert.notEqual(ruta, null);
    assert.ok(
      ruta!.distanciaM > 200 && ruta!.distanciaM < 300,
      `desde mitad de calle deben ser ~233 m, midió ${Math.round(ruta!.distanciaM)}`,
    );
  } finally {
    cargarPlano(plano);
  }
});
