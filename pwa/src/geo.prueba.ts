// Pruebas del cálculo de distancias y del orden por cercanía.
//
// Lo que se fija aquí es lo que decide qué zona ve primero el taxista al entrar
// en servicio. Si el orden se equivoca, declara que trabaja en un barrio en el
// que no está, y las carreras de su propia calle le llegan tarde —por la
// tercera oleada del reparto— o no le llegan.
//
// Ejecutar: npm run probar   (desde /pwa)

import test from 'node:test';
import assert from 'node:assert/strict';
import { metrosEntre, porCercaniaA, rumboEntre, velocidadKmhEntre } from './geo.js';
import { rumboDeBrujula } from './brujula.js';

// Barrios reales de Malabo, con los centroides del gazetteer.
const BARRIO_CHINO = { id: 1, nombre: 'Barrio Chino', lat: 3.74966, lng: 8.77969 };
const LOS_ANGELES = { id: 2, nombre: 'Los Ángeles', lat: 3.74824, lng: 8.77778 };
const MALABO_CENTRO = { id: 3, nombre: 'Malabo Centro', lat: 3.75416, lng: 8.77997 };
const ELA_NGUEMA = { id: 4, nombre: 'Ela Nguema', lat: 3.75681, lng: 8.7996 };
const BANEY = { id: 5, nombre: 'Baney', lat: 3.70129, lng: 8.91023 };

test('la distancia coincide con la realidad: Malabo Centro y Ela Nguema están a ~2 km', () => {
  const d = metrosEntre(MALABO_CENTRO, ELA_NGUEMA);
  assert.ok(d > 1_800 && d < 2_400, `dio ${Math.round(d)} m`);
});

test('la distancia es simétrica y cero contra uno mismo', () => {
  assert.equal(Math.round(metrosEntre(BARRIO_CHINO, BANEY)), Math.round(metrosEntre(BANEY, BARRIO_CHINO)));
  assert.equal(metrosEntre(BARRIO_CHINO, { ...BARRIO_CHINO }), 0);
});

test('el taxista parado en el Mercado Central ve su barrio primero, no el alfabético', () => {
  const zonas = [ELA_NGUEMA, BANEY, MALABO_CENTRO, BARRIO_CHINO, LOS_ANGELES];
  // Mercado Central: el punto donde de verdad está el coche.
  const cerca = porCercaniaA({ lat: 3.7488, lng: 8.78006 }, zonas);

  assert.equal(cerca[0].nombre, 'Barrio Chino',
    'la primera opción tiene que ser el barrio en el que está');
  assert.equal(cerca[cerca.length - 1].nombre, 'Baney',
    'y el pueblo a 13 km, el último');

  // Ordenado alfabéticamente, «Baney» saldría el primero y «Barrio Chino»
  // el segundo: justo el fallo que esto arregla.
  const alfabetico = [...zonas].sort((a, b) => a.nombre.localeCompare(b.nombre));
  assert.notEqual(alfabetico[0].nombre, cerca[0].nombre);
});

test('ordenar por cercanía no toca la lista que recibe', () => {
  const zonas = [ELA_NGUEMA, BANEY, BARRIO_CHINO];
  const copia = [...zonas];
  porCercaniaA({ lat: 3.7488, lng: 8.78006 }, zonas);
  assert.deepEqual(zonas, copia, 'reordenar la lista de quien llama sería una sorpresa desagradable');
});

test('el orden es completo y no pierde ni repite zonas', () => {
  const zonas = [ELA_NGUEMA, BANEY, MALABO_CENTRO, BARRIO_CHINO, LOS_ANGELES];
  const cerca = porCercaniaA({ lat: 3.7488, lng: 8.78006 }, zonas);
  assert.equal(cerca.length, zonas.length);
  assert.deepEqual(
    [...cerca].map((z) => z.id).sort(),
    [...zonas].map((z) => z.id).sort(),
  );
});

test('las distancias salen crecientes: es lo que hace fiable la primera opción', () => {
  const zonas = [ELA_NGUEMA, BANEY, MALABO_CENTRO, BARRIO_CHINO, LOS_ANGELES];
  const yo = { lat: 3.7488, lng: 8.78006 };
  const distancias = porCercaniaA(yo, zonas).map((z) => metrosEntre(yo, z));
  for (let i = 1; i < distancias.length; i += 1) {
    assert.ok(distancias[i] >= distancias[i - 1],
      `la ${i + 1}ª está más cerca que la ${i}ª: ${Math.round(distancias[i])} < ${Math.round(distancias[i - 1])}`);
  }
});

// --- Rumbo -------------------------------------------------------------------
//
// Lo que decide hacia dónde se gira el plano del taxista mientras conduce. Si
// se equivoca, el conductor ve el plano al revés de por donde va, que es peor
// que no girarlo.

test('el rumbo entre dos puntos sale en grados desde el norte', () => {
  const centro = { lat: 3.7531, lng: 8.7752 };
  const norte = { lat: 3.7631, lng: 8.7752 };
  const sur = { lat: 3.7431, lng: 8.7752 };
  const este = { lat: 3.7531, lng: 8.7852 };
  const oeste = { lat: 3.7531, lng: 8.7652 };

  assert.ok(Math.abs(rumboEntre(centro, norte) - 0) < 0.5, 'al norte, 0°');
  assert.ok(Math.abs(rumboEntre(centro, este) - 90) < 0.5, 'al este, 90°');
  assert.ok(Math.abs(rumboEntre(centro, sur) - 180) < 0.5, 'al sur, 180°');
  assert.ok(Math.abs(rumboEntre(centro, oeste) - 270) < 0.5, 'al oeste, 270°');
});

test('el rumbo nunca sale negativo: 0 a 360, como el del GPS', () => {
  const centro = { lat: 3.7531, lng: 8.7752 };
  // Al noroeste: la cuenta directa daría -45°, que giraría el plano igual pero
  // rompería la comparación con el rumbo del GPS, que va de 0 a 360.
  const noroeste = { lat: 3.7631, lng: 8.7652 };
  const rumbo = rumboEntre(centro, noroeste);
  assert.ok(rumbo >= 0 && rumbo < 360, `salió ${rumbo}`);
  assert.ok(Math.abs(rumbo - 315) < 1, 'al noroeste, 315°');
});

test('un caso de verdad: del Barrio Chino a Ela Nguema se va hacia el nordeste', () => {
  const rumbo = rumboEntre(BARRIO_CHINO, ELA_NGUEMA);
  assert.ok(rumbo > 45 && rumbo < 90, `esperaba nordeste y salió ${rumbo.toFixed(0)}°`);
});

// --- Velocidad entre dos lecturas del GPS ----------------------------------

test('velocidad: 100 m en 10 s son 36 km/h', () => {
  const desde = { lat: 3.75, lng: 8.78, en: 0 };
  // 100 m al norte: un grado de latitud son 111.320 m.
  const hasta = { lat: 3.75 + 100 / 111_320, lng: 8.78, en: 10_000 };
  assert.equal(velocidadKmhEntre(desde, hasta), 36);
});

test('velocidad: dos lecturas demasiado seguidas no dan velocidad, dan ruido', () => {
  // Diez metros de temblor del GPS con el coche PARADO en un semáforo. En un
  // segundo eso son 36 km/h, y el velocímetro los marcaría.
  const desde = { lat: 3.75, lng: 8.78, en: 0 };
  const hasta = { lat: 3.75 + 10 / 111_320, lng: 8.78, en: 1000 };
  assert.equal(velocidadKmhEntre(desde, hasta), null);
});

test('velocidad: un salto del GPS se descarta en vez de enseñar un absurdo', () => {
  // Un rebote entre edificios: dos kilómetros en cinco segundos son 1.440 km/h.
  const desde = { lat: 3.75, lng: 8.78, en: 0 };
  const hasta = { lat: 3.75 + 2000 / 111_320, lng: 8.78, en: 5000 };
  assert.equal(velocidadKmhEntre(desde, hasta), null);
});

test('velocidad: parado de verdad marca cero, no null', () => {
  const desde = { lat: 3.75, lng: 8.78, en: 0 };
  const hasta = { lat: 3.75, lng: 8.78, en: 10_000 };
  assert.equal(velocidadKmhEntre(desde, hasta), 0);
});

// --- Brújula ---------------------------------------------------------------

test('brújula iOS: webkitCompassHeading ya viene en grados desde el norte', () => {
  assert.equal(rumboDeBrujula({ webkitCompassHeading: 90 }), 90);
  assert.equal(rumboDeBrujula({ webkitCompassHeading: 0 }), 0);
});

test('brújula Android: alpha cuenta al revés, hay que restarlo de 360', () => {
  // Mirando al este, un evento absoluto de Chrome trae alpha = 270.
  assert.equal(rumboDeBrujula({ alpha: 270, absolute: true }), 90);
  assert.equal(rumboDeBrujula({ alpha: 0, absolute: true }), 0);
});

test('brújula: un alpha NO absoluto se descarta, aunque venga un número', () => {
  // Sin `absolute` el alpha es relativo a donde estaba el móvil al empezar a
  // escuchar: no es un rumbo, es un número que lo parece. Usarlo pondría el
  // coche mirando a cualquier parte según cómo se hubiera dejado el teléfono.
  assert.equal(rumboDeBrujula({ alpha: 120 }), null);
  assert.equal(rumboDeBrujula({ alpha: 120, absolute: false }), null);
});

test('brújula: el giro de la pantalla se suma, o el coche apunta 90° a un lado', () => {
  // Con el móvil tumbado, el «arriba» de la pantalla no es el del aparato.
  assert.equal(rumboDeBrujula({ webkitCompassHeading: 10 }, 90), 100);
  assert.equal(rumboDeBrujula({ alpha: 0, absolute: true }, 270), 270);
});

test('brújula: siempre entre 0 y 360, sin negativos ni vueltas de más', () => {
  assert.equal(rumboDeBrujula({ webkitCompassHeading: 350 }, 90), 80);
  assert.equal(rumboDeBrujula({ alpha: 350, absolute: true }, 0), 10);
});
