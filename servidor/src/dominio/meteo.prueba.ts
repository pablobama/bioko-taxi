// La franja del tiempo de Malabo (migración 091): el mapa de códigos del cielo
// y la regla de cuándo salta cada aviso. Son reglas puras, sin red ni base de
// datos, así que esta batería no toca Open-Meteo ni Postgres.
//
// Ejecutar: npm run probar

import test from 'node:test';
import assert from 'node:assert/strict';
import { cieloDesdeCodigo, decidirAviso } from './meteo.js';

test('el código WMO se agrupa en los cuatro cielos que dibuja la app', () => {
  assert.equal(cieloDesdeCodigo(0), 'sol');
  assert.equal(cieloDesdeCodigo(1), 'nubes');
  assert.equal(cieloDesdeCodigo(3), 'nubes');
  assert.equal(cieloDesdeCodigo(45), 'nubes'); // niebla
  assert.equal(cieloDesdeCodigo(61), 'lluvia');
  assert.equal(cieloDesdeCodigo(80), 'lluvia'); // chubascos
  assert.equal(cieloDesdeCodigo(95), 'tormenta');
  assert.equal(cieloDesdeCodigo(99), 'tormenta');
});

test('lluvia por cielo: tormenta o lluvia avisan aunque la probabilidad sea baja', () => {
  assert.equal(decidirAviso('lluvia', 25, 0, 33, 60), 'lluvia');
  assert.equal(decidirAviso('tormenta', 25, 0, 33, 60), 'lluvia');
});

test('lluvia por probabilidad: con cielo seco pero probabilidad alta, avisa de lluvia', () => {
  assert.equal(decidirAviso('nubes', 25, 60, 33, 60), 'lluvia');
  assert.equal(decidirAviso('sol', 25, 75, 33, 60), 'lluvia');
});

test('calor: con la sensación en el umbral y sin lluvia, avisa de calor', () => {
  assert.equal(decidirAviso('sol', 33, 10, 33, 60), 'calor');
  assert.equal(decidirAviso('nubes', 35, 59, 33, 60), 'calor');
});

test('la lluvia manda sobre el calor: aunque haga calor, si va a llover el aviso es de lluvia', () => {
  assert.equal(decidirAviso('sol', 40, 80, 33, 60), 'lluvia');
});

test('sin motivo no hay aviso: ni calor ni lluvia bajo umbral', () => {
  assert.equal(decidirAviso('sol', 32, 59, 33, 60), null);
  assert.equal(decidirAviso('nubes', 30, 0, 33, 60), null);
});

test('los umbrales mandan: subir el de calor silencia un aviso que antes saltaba', () => {
  assert.equal(decidirAviso('sol', 34, 0, 33, 60), 'calor');
  assert.equal(decidirAviso('sol', 34, 0, 36, 60), null);
});
