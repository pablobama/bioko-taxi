// La aritmética del número de taxi (migración 084), sin base de datos. Los
// casos que importan son las FRONTERAS: donde se acaba una letra y donde se
// acaban todas — equivocarse ahí repartiría el mismo número dos veces, y el
// número es para siempre.

import test from 'node:test';
import assert from 'node:assert/strict';
import { indiceDeNumero, numeroDeIndice } from './numeros-taxi.js';

test('la secuencia: A000, las fronteras de letra y el salto a dos letras', () => {
  assert.equal(numeroDeIndice(0), 'A000');
  assert.equal(numeroDeIndice(13), 'A013');
  assert.equal(numeroDeIndice(999), 'A999');
  assert.equal(numeroDeIndice(1000), 'B000');
  assert.equal(numeroDeIndice(25999), 'Z999');
  assert.equal(numeroDeIndice(26000), 'AA000');
  assert.equal(numeroDeIndice(26999), 'AA999');
  assert.equal(numeroDeIndice(27000), 'AB000');
});

test('ida y vuelta: todo número vuelve a su índice', () => {
  for (const indice of [0, 1, 999, 1000, 12345, 25999, 26000, 27000, 701999]) {
    assert.equal(indiceDeNumero(numeroDeIndice(indice)), indice, `índice ${indice}`);
  }
});

test('se teclea con prisa: minúsculas y espacios valen; lo que no es, no', () => {
  assert.equal(indiceDeNumero(' a013 '), 13);
  assert.equal(indiceDeNumero('ab000'), 27000);
  for (const malo of ['', 'A13', 'A0133', '013', 'AAA000', 'A01E', '13A0']) {
    assert.equal(indiceDeNumero(malo), null, `«${malo}» no debería valer`);
  }
});

test('el abecedario se acaba ruidosamente, no repartiendo repetidos', () => {
  assert.throws(() => numeroDeIndice(702000), /abecedario/);
  assert.throws(() => numeroDeIndice(-1));
  assert.throws(() => numeroDeIndice(1.5));
});
