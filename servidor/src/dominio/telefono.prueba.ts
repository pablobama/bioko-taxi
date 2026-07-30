// Pruebas del teléfono como clave de identidad (migración 024).
//
// Ejecutar: npm run probar

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizarTelefono, telefonoLegible } from './telefono.js';

test('el mismo número escrito de cinco formas da la misma clave', () => {
  const formas = [
    '+240222410986',
    '222410986',
    '00240222410986',
    '+240 222 41 09 86',
    '240-222-410-986',
  ];
  const claves = new Set(formas.map((f) => normalizarTelefono(f)));
  assert.equal(
    claves.size, 1,
    `deberían ser una sola clave y son ${[...claves].join(', ')}`,
  );
  assert.equal([...claves][0], '+240222410986');
});

test('lo que no puede ser un teléfono se rechaza en vez de guardarse a medias', () => {
  for (const basura of ['', '   ', 'no soy un teléfono', '12345', null, undefined]) {
    assert.equal(normalizarTelefono(basura), null, `«${basura}» no es un teléfono`);
  }
  // Demasiado largo para E.164.
  assert.equal(normalizarTelefono('1234567890123456'), null);
});

test('un número de fuera se conserva, no se le inventa el prefijo de Guinea', () => {
  // Español: 9 dígitos como los locales, así que ojo — este caso es
  // deliberadamente ambiguo y se resuelve como local. Lo documenta el módulo:
  // sin más contexto, nueve dígitos en esta aplicación son de Malabo.
  assert.equal(normalizarTelefono('600123456'), '+240600123456');
  // Con prefijo internacional explícito sí se distingue.
  assert.equal(normalizarTelefono('+34600123456'), '+34600123456');
  assert.equal(normalizarTelefono('0034600123456'), '+34600123456');
});

test('el número se puede leer en voz alta, para dictarlo por teléfono', () => {
  assert.equal(telefonoLegible('+240222410986'), '222 41 09 86');
  // De fuera se deja tal cual: no sabemos cómo se agrupa.
  assert.equal(telefonoLegible('+34600123456'), '+34600123456');
});
