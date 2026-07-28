// Pruebas de la proyección y de la cámara del plano, contra el plano real de
// Malabo.
//
// Lo que se comprueba aquí es lo que el usuario ve: que el encuadre deje
// dentro de la pantalla lo que tiene que ver en cada fase del viaje. Si la
// cámara se equivoca, el pasajero pierde de vista el taxi que viene a por él.
//
// Ejecutar: npm run probar   (desde /pwa)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  aPantalla, construirTrazados, crearProyeccion, encuadrar, transformacion,
  type Plano, type Punto2D,
} from './proyeccion.js';

const plano: Plano = JSON.parse(
  readFileSync(new URL('./mapa-malabo.json', import.meta.url), 'utf8'),
);
const proy = crearProyeccion(plano.recuadro);

// Sitios reales del gazetteer de Malabo.
const MERCADO_CENTRAL = { lat: 3.7531, lng: 8.7752 };
const CATEDRAL = { lat: 3.7539, lng: 8.7737 };
const SEMU = { lat: 3.758, lng: 8.766 };

// Una pantalla de móvil corriente, ya descontada la hoja inferior.
const ANCHO = 360;
const ALTO = 420;

const mundo = (p: { lat: number; lng: number }): Punto2D => proy.aMundo(p.lat, p.lng);

function metrosRectos(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

test('la proyección conserva las distancias: un grado de latitud son ~111 km', () => {
  const a = proy.aMundo(3.75, 8.78);
  const b = proy.aMundo(4.75, 8.78);
  const unidades = Math.abs(b[1] - a[1]);
  const metros = unidades / proy.unidadesPorMetro;
  // 111.194 m por grado; se admite un 1 % por el radio esférico medio.
  assert.ok(Math.abs(metros - 111_195) < 1_200, `un grado dio ${Math.round(metros)} m`);
});

test('la proyección no estira el plano: 100 m al norte miden lo mismo que 100 m al este', () => {
  const centro = { lat: 3.75, lng: 8.78 };
  const gradoLat = 100 / 111_195;
  const norte = { lat: centro.lat + gradoLat, lng: centro.lng };
  const este = { lat: centro.lat, lng: centro.lng + gradoLat / Math.cos((3.75 * Math.PI) / 180) };

  const dNorte = Math.abs(mundo(norte)[1] - mundo(centro)[1]);
  const dEste = Math.abs(mundo(este)[0] - mundo(centro)[0]);
  const desvio = Math.abs(dNorte - dEste) / dNorte;
  assert.ok(desvio < 0.01, `las dos direcciones difieren un ${(desvio * 100).toFixed(1)} %`);
});

test('el norte queda arriba: más latitud, menos y', () => {
  assert.ok(mundo({ lat: 3.76, lng: 8.78 })[1] < mundo({ lat: 3.75, lng: 8.78 })[1]);
});

test('encuadrar un solo punto lo deja centrado en la pantalla', () => {
  const cam = encuadrar([mundo(MERCADO_CENTRAL)], ANCHO, ALTO, proy);
  assert.notEqual(cam, null);
  const xy = aPantalla(mundo(MERCADO_CENTRAL), cam!, ANCHO, ALTO);
  assert.ok(Math.abs(xy[0] - ANCHO / 2) < 0.5, `x fuera del centro: ${xy[0]}`);
  assert.ok(Math.abs(xy[1] - ALTO / 2) < 0.5, `y fuera del centro: ${xy[1]}`);
});

test('encuadrar dos puntos deja los dos dentro, con margen', () => {
  const margen = 40;
  const cam = encuadrar(
    [mundo(MERCADO_CENTRAL), mundo(SEMU)], ANCHO, ALTO, proy, { margen },
  );
  assert.notEqual(cam, null);
  for (const sitio of [MERCADO_CENTRAL, SEMU]) {
    const [x, y] = aPantalla(mundo(sitio), cam!, ANCHO, ALTO);
    assert.ok(x >= margen - 1 && x <= ANCHO - margen + 1, `x=${x.toFixed(0)} se sale`);
    assert.ok(y >= margen - 1 && y <= ALTO - margen + 1, `y=${y.toFixed(0)} se sale`);
  }
});

// El caso de uso central: el taxi acepta y el mapa tiene que abrirse para que
// el pasajero vea de dónde viene y por dónde va a llegar.
test('al aceptar el taxi, el encuadre se abre y mete al coche en pantalla', () => {
  const persona = encuadrar([mundo(MERCADO_CENTRAL)], ANCHO, ALTO, proy, { metrosMinimos: 700 });
  const taxiLejos = { lat: 3.7605, lng: 8.7830 };

  // Con solo la persona encuadrada, el taxi está fuera de la pantalla.
  const antes = aPantalla(mundo(taxiLejos), persona!, ANCHO, ALTO);
  const dentro = (xy: Punto2D) => xy[0] >= 0 && xy[0] <= ANCHO && xy[1] >= 0 && xy[1] <= ALTO;
  assert.ok(!dentro(antes), 'el taxi no debería caber en el encuadre de la persona sola');

  // Al añadirlo, la cámara se aleja y los dos caben.
  const recogida = encuadrar(
    [mundo(MERCADO_CENTRAL), mundo(taxiLejos)], ANCHO, ALTO, proy,
  );
  assert.ok(recogida!.escala < persona!.escala, 'la cámara tiene que alejarse, no acercarse');
  assert.ok(dentro(aPantalla(mundo(taxiLejos), recogida!, ANCHO, ALTO)), 'el taxi debe caber');
  assert.ok(dentro(aPantalla(mundo(MERCADO_CENTRAL), recogida!, ANCHO, ALTO)), 'la persona también');
});

test('encuadrar la ruta entera mantiene dentro todos sus vértices', () => {
  // Una ruta en forma de L: si solo se encuadraran los extremos, el codo se
  // saldría de la pantalla.
  const vertices = [
    mundo(MERCADO_CENTRAL),
    mundo({ lat: 3.7605, lng: 8.7752 }),
    mundo({ lat: 3.7605, lng: 8.7660 }),
    mundo(SEMU),
  ];
  const cam = encuadrar(vertices, ANCHO, ALTO, proy, { margen: 30 });
  for (const v of vertices) {
    const [x, y] = aPantalla(v, cam!, ANCHO, ALTO);
    assert.ok(x >= 0 && x <= ANCHO && y >= 0 && y <= ALTO, `vértice fuera: ${x.toFixed(0)},${y.toFixed(0)}`);
  }
});

test('el zoom tiene topes: ni pegado a un punto ni Malabo entero de lejos', () => {
  const unSitio = encuadrar([mundo(MERCADO_CENTRAL)], ANCHO, ALTO, proy, {
    metrosMinimos: 700, metrosMaximos: 14_000,
  })!;
  // Lo más cerca: 700 m de ancho, no infinito.
  const metrosVisibles = ANCHO / (unSitio.escala * proy.unidadesPorMetro);
  assert.ok(Math.abs(metrosVisibles - 700) < 20, `se ven ${Math.round(metrosVisibles)} m, no 700`);

  // Lo más lejos: dos puntos absurdamente separados no alejan más del tope.
  const lejisimos = encuadrar(
    [mundo({ lat: 3.70, lng: 8.71 }), mundo({ lat: 3.81, lng: 8.84 })],
    ANCHO, ALTO, proy, { metrosMaximos: 14_000 },
  )!;
  const anchoTope = ANCHO / (lejisimos.escala * proy.unidadesPorMetro);
  assert.ok(anchoTope <= 14_050, `se alejó hasta ${Math.round(anchoTope)} m`);
});

test('sin puntos no hay encuadre: se dice con null en vez de inventarse uno', () => {
  assert.equal(encuadrar([], ANCHO, ALTO, proy), null);
  assert.equal(encuadrar([mundo(CATEDRAL)], 0, 0, proy), null);
});

test('la escala en pantalla es coherente: dos sitios a 1 km caen a la distancia debida', () => {
  const cam = encuadrar([mundo(MERCADO_CENTRAL), mundo(SEMU)], ANCHO, ALTO, proy)!;
  const a = aPantalla(mundo(MERCADO_CENTRAL), cam, ANCHO, ALTO);
  const b = aPantalla(mundo(SEMU), cam, ANCHO, ALTO);
  const pixeles = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const metros = metrosRectos(MERCADO_CENTRAL, SEMU);
  const metrosPorPixel = metros / pixeles;
  const esperado = 1 / (cam.escala * proy.unidadesPorMetro);
  assert.ok(Math.abs(metrosPorPixel - esperado) / esperado < 0.02,
    `${metrosPorPixel.toFixed(2)} m/px medidos frente a ${esperado.toFixed(2)} esperados`);
});

test('el transform del plano coloca el centro de la cámara en el centro de la pantalla', () => {
  const cam = encuadrar([mundo(CATEDRAL)], ANCHO, ALTO, proy)!;
  const t = transformacion(cam, ANCHO, ALTO);
  const m = /^translate\((-?[\d.]+),(-?[\d.]+)\) scale\(([\d.]+)\)$/.exec(t);
  assert.notEqual(m, null, `transform con forma inesperada: ${t}`);
  const [tx, ty, s] = [Number(m![1]), Number(m![2]), Number(m![3])];
  // Aplicar el transform a mano tiene que dar lo mismo que aPantalla.
  const esperado = aPantalla(mundo(CATEDRAL), cam, ANCHO, ALTO);
  const obtenido = [mundo(CATEDRAL)[0] * s + tx, mundo(CATEDRAL)[1] * s + ty];
  assert.ok(Math.abs(obtenido[0] - esperado[0]) < 0.5, `x: ${obtenido[0]} vs ${esperado[0]}`);
  assert.ok(Math.abs(obtenido[1] - esperado[1]) < 0.5, `y: ${obtenido[1]} vs ${esperado[1]}`);
});

test('los trazados del plano salen completos y en forma de path de SVG', () => {
  const trazados = construirTrazados(plano, proy);
  for (const clase of [1, 2, 3, 4]) {
    assert.ok(trazados.porClase[clase].startsWith('M'),
      `la clase ${clase} no empieza por M: «${trazados.porClase[clase].slice(0, 20)}»`);
  }
  // Las cuatro clases juntas tienen que sumar una M por vía.
  const emes = [1, 2, 3, 4]
    .map((c) => (trazados.porClase[c].match(/M/g) ?? []).length)
    .reduce((a, b) => a + b, 0);
  assert.equal(emes, plano.vias.length, 'se ha perdido alguna vía al construir los trazados');

  assert.ok(trazados.mar.length > 0, 'sin mar no hay costa que dibujar');
  assert.ok(trazados.mar.includes('Z'), 'el mar tiene que ser un polígono cerrado');
  assert.ok(!trazados.costa.includes('Z'), 'la costa es una línea abierta, no un polígono');
});
