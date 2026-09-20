// Pruebas de la guía por voz. Puras: ni navegador ni plano.
//
// Ejecutar: npm run probar

import test from 'node:test';
import assert from 'node:assert/strict';
import { maniobrasDeLaRuta, proximoAviso, type Punto } from './guia.js';

// Un metro de latitud son ~1/111320 grados; de longitud, casi lo mismo en
// Malabo (lat 3,75, el coseno vale 0,998). Se construyen rutas en metros para
// poder razonar sobre ellas.
const BASE = { lat: 3.75, lng: 8.78 };
function punto(norteM: number, esteM: number): Punto {
  return {
    lat: BASE.lat + norteM / 111_320,
    lng: BASE.lng + esteM / (111_320 * Math.cos((BASE.lat * Math.PI) / 180)),
  };
}

// Una recta de `largo` metros hacia el norte, con un vértice cada 10 m: así
// son las rutas del grafo, llenas de vértices intermedios.
function recta(desdeN: number, hastaN: number, esteM = 0): Punto[] {
  const puntos: Punto[] = [];
  for (let n = desdeN; n <= hastaN; n += 10) puntos.push(punto(n, esteM));
  return puntos;
}

test('una calle recta no tiene maniobras, solo la llegada', () => {
  const lista = maniobrasDeLaRuta(recta(0, 500));
  assert.equal(lista.length, 1);
  assert.equal(lista[0].giro, 'llegada');
});

test('una curva suave de carretera no se canta como giro', () => {
  // Diez vértices girando 8° cada uno: 80° en total, pero repartidos. Es la
  // curva de una carretera, no un cruce.
  const puntos: Punto[] = [punto(0, 0)];
  let rumbo = 0;
  let n = 0;
  let e = 0;
  for (let i = 0; i < 12; i += 1) {
    rumbo += 8;
    n += 25 * Math.cos((rumbo * Math.PI) / 180);
    e += 25 * Math.sin((rumbo * Math.PI) / 180);
    puntos.push(punto(n, e));
  }
  const giros = maniobrasDeLaRuta(puntos).filter((m) => m.giro !== 'llegada');
  assert.equal(giros.length, 0, `no debería haber giros y salieron ${giros.length}`);
});

test('un cruce en ángulo recto sí es una maniobra, y con su lado', () => {
  // 300 m al norte y luego 300 m al este: se gira a la DERECHA.
  const puntos = [...recta(0, 300), ...recta(0, 300, 0).map((_, i) => punto(300, i * 10))];
  const giros = maniobrasDeLaRuta(puntos).filter((m) => m.giro !== 'llegada');
  assert.equal(giros.length, 1, `esperaba un giro y salieron ${giros.length}`);
  assert.equal(giros[0].giro, 'derecha');
  assert.ok(Math.abs(giros[0].desdeElInicioM - 300) < 20);
});

test('yendo al norte y torciendo al oeste el giro es a la izquierda', () => {
  const puntos = [...recta(0, 300), ...Array.from({ length: 31 }, (_, i) => punto(300, -i * 10))];
  const giros = maniobrasDeLaRuta(puntos).filter((m) => m.giro !== 'llegada');
  assert.equal(giros[0].giro, 'izquierda');
});

test('el aviso llega a doscientos metros y no antes', () => {
  const puntos = [...recta(0, 300), ...Array.from({ length: 31 }, (_, i) => punto(300, i * 10))];
  const dichas = new Set<string>();

  // A 300 m del cruce todavía no se dice nada.
  assert.equal(proximoAviso(puntos, punto(0, 0), dichas), null);

  // A 150 m, sí.
  const aviso = proximoAviso(puntos, punto(150, 0), dichas);
  assert.ok(aviso !== null, 'a 150 m del cruce tiene que avisar');
  assert.equal(aviso!.giro, 'derecha');
  assert.equal(aviso!.metros, 200);
});

test('el mismo aviso no se repite, pero el de encima del cruce sí llega', () => {
  const puntos = [...recta(0, 300), ...Array.from({ length: 31 }, (_, i) => punto(300, i * 10))];
  const dichas = new Set<string>();

  const largo = proximoAviso(puntos, punto(150, 0), dichas)!;
  dichas.add(largo.clave);
  // Un metro más adelante no vuelve a decir lo mismo.
  assert.equal(proximoAviso(puntos, punto(160, 0), dichas), null);

  // Pegado al cruce, el segundo aviso: el giro a secas, sin distancia.
  const corto = proximoAviso(puntos, punto(280, 0), dichas);
  assert.ok(corto !== null, 'encima del cruce hay que volver a decirlo');
  assert.equal(corto!.giro, 'derecha');
  assert.equal(corto!.metros, 0);
});

test('la llegada se canta al final y una sola vez', () => {
  const puntos = recta(0, 300);
  const dichas = new Set<string>();
  assert.equal(proximoAviso(puntos, punto(100, 0), dichas), null, 'a 200 m no se canta llegada');

  const aviso = proximoAviso(puntos, punto(280, 0), dichas);
  assert.ok(aviso !== null);
  assert.equal(aviso!.giro, 'llegada');
  dichas.add(aviso!.clave);
  assert.equal(proximoAviso(puntos, punto(290, 0), dichas), null);
});
