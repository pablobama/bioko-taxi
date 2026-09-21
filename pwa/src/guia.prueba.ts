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

  // Acercándose, sí. (El cruce está en el vértice 290, no en el 300: el
  // último punto de la recta y el primero del tramo al este son el mismo.)
  const aviso = proximoAviso(puntos, punto(120, 0), dichas);
  assert.ok(aviso !== null, 'a 170 m del cruce tiene que avisar');
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

// --- Lo que encontró el diagnóstico del 20/09 ------------------------------

test('rehacer la ruta desde el coche no vuelve a cantar el mismo giro', () => {
  // Es el fallo que se oía: el plano recalcula la ruta cada veinte metros, y
  // como la maniobra se identificaba por su distancia desde el principio —que
  // cambia en cada recálculo—, el aviso parecía nuevo cada vez. Doce «en
  // doscientos metros, gira a la izquierda» para un solo cruce.
  const completa = [...recta(0, 300), ...Array.from({ length: 31 }, (_, i) => punto(300, i * 10))];
  const dichas = new Set<string>();

  const primero = proximoAviso(completa, punto(150, 0), dichas);
  assert.ok(primero !== null);
  dichas.add(primero!.clave);

  // La aplicación rehace la ruta DESDE donde está el coche: los mismos cruces,
  // pero cien metros menos por delante.
  const rehecha = [...recta(160, 300), ...Array.from({ length: 31 }, (_, i) => punto(300, i * 10))];
  assert.equal(proximoAviso(rehecha, punto(170, 0), dichas), null,
    'el cruce es el mismo: no hay nada nuevo que decir');
});

test('el enganche a la calzada no inventa un giro nada más arrancar', () => {
  // La ruta no empieza en el coche sino en el punto de la calzada más cercano,
  // y ese primer tramo va de lado. El ángulo con el siguiente es enorme y se
  // leía como un cruce: en la carretera del aeropuerto, recta entera, la voz
  // pedía girar cada veinte metros.
  const conEnganche = [
    punto(0, -8), // el coche, a ocho metros de la calzada
    ...recta(0, 600), // la avenida, recta
  ];
  const giros = maniobrasDeLaRuta(conEnganche).filter((m) => m.giro !== 'llegada');
  assert.equal(giros.length, 0, `una avenida recta no tiene giros, y salieron ${giros.length}`);
});

test('la distancia que se dice es la que falta, no el escalón', () => {
  // Antes decía «en doscientos metros» faltaran doscientos o treinta.
  const puntos = [...recta(0, 300), ...Array.from({ length: 31 }, (_, i) => punto(300, i * 10))];
  // A 190 m del cruce: el aviso de lejos entra, y tiene que decir 200.
  const lejos = proximoAviso(puntos, punto(110, 0), new Set());
  assert.equal(lejos!.metros, 200);

  // Si el coche llega rápido y la primera lectura dentro del escalón lo pilla
  // a 120 m, se dicen cien, no doscientos.
  const cerca = proximoAviso(puntos, punto(180, 0), new Set());
  assert.equal(cerca!.metros, 100);
});

test('en una rotonda se dice la salida, y se dice una sola vez', () => {
  // La ruta: 300 m al norte, el anillo (cuatro puntos) y salida al este. Las
  // salidas las cuenta rutas.ts con el grafo; aquí se le pasan hechas, que es
  // como llegan.
  const anillo = [punto(300, 0), punto(310, 10), punto(310, 25), punto(300, 35)];
  const puntos = [
    ...recta(0, 290),
    ...anillo,
    ...Array.from({ length: 20 }, (_, i) => punto(300, 45 + i * 10)),
  ];
  const entrada = puntos.length - 20 - anillo.length;
  const rotondas = new Map([[entrada, { salida: 2, indiceSalida: entrada + 3 }]]);

  const maniobras = maniobrasDeLaRuta(puntos, rotondas);
  const rotonda = maniobras.find((m) => m.giro === 'rotonda');
  assert.ok(rotonda, 'la rotonda tiene que salir como maniobra');
  assert.equal(rotonda!.salida, 2);

  // Y dentro del anillo no se sueltan giros sueltos: en una rotonda se gira
  // todo el rato, decir «gira a la derecha» ahí no significa nada.
  const dentro = maniobras.filter((m) => m.giro === 'derecha' || m.giro === 'izquierda');
  assert.equal(dentro.length, 0, `no debería haber giros sueltos y hay ${dentro.length}`);

  const dichas = new Set<string>();
  const aviso = proximoAviso(puntos, punto(150, 0), dichas, rotondas);
  assert.equal(aviso!.giro, 'rotonda');
  assert.equal(aviso!.salida, 2);
  dichas.add(aviso!.clave);

  // Ya dentro del anillo, la ruta rehecha entra por otro punto y quedan menos
  // salidas. No puede volver a cantarse: se identifica por LA SALIDA, que no
  // se mueve.
  const rehecha = [...anillo.slice(1), ...Array.from({ length: 20 }, (_, i) => punto(300, 45 + i * 10))];
  const rotondasRehecha = new Map([[0, { salida: 1, indiceSalida: 2 }]]);
  assert.equal(proximoAviso(rehecha, punto(310, 12), dichas, rotondasRehecha), null,
    'es la misma rotonda: ya se dijo');
});

test('la rotonda se avisa dos veces: antes de entrar y ya dentro', () => {
  // Lo que pidió el taxista que la probó: el aviso de antes de entrar no
  // sirve treinta segundos después, dando vueltas dentro del anillo.
  const anillo = [punto(300, 0), punto(310, 10), punto(310, 25), punto(300, 35)];
  const puntos = [
    ...recta(0, 290),
    ...anillo,
    ...Array.from({ length: 20 }, (_, i) => punto(300, 45 + i * 10)),
  ];
  const entrada = puntos.length - 20 - anillo.length;
  const rotondas = new Map([[entrada, { salida: 2, indiceSalida: entrada + 3 }]]);
  const dichas = new Set<string>();

  // Llegando: el número de salida.
  const antes = proximoAviso(puntos, punto(150, 0), dichas, rotondas);
  assert.equal(antes!.giro, 'rotonda');
  assert.equal(antes!.salida, 2);
  assert.ok(antes!.metros > 0, 'de lejos se dice la distancia');
  dichas.add(antes!.clave);

  // Dentro del anillo, entre la entrada y la salida: todavía no toca.
  const dentro = proximoAviso(puntos, punto(305, 5), dichas, rotondas);
  assert.equal(dentro, null, 'nada más entrar no hay nada nuevo que decir');

  // Pegado a su salida: «sal aquí», sin número.
  const saliendo = proximoAviso(puntos, punto(310, 22), dichas, rotondas);
  assert.ok(saliendo !== null, 'dentro del anillo hay que avisar de la salida');
  assert.equal(saliendo!.giro, 'rotonda');
  assert.equal(saliendo!.metros, 0);
  dichas.add(saliendo!.clave);

  // Y una sola vez.
  assert.equal(proximoAviso(puntos, punto(308, 28), dichas, rotondas), null);
});
