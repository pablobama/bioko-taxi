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
import { metrosEntre, porCercaniaA } from './geo.js';

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
