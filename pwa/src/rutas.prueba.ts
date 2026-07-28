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
