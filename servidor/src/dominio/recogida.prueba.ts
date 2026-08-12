// Pruebas del punto de recogida (migración 046). Puras: sin base de datos.
//
// Ejecutar: npm run probar

import test from 'node:test';
import assert from 'node:assert/strict';
import { puntoDeRecogida } from './recogida.js';

// El supermercado del caso real, y la persona a unos 90 m de él.
const SUPERMERCADO = { referenciaLat: 3.75410, referenciaLng: 8.77990 };
const A_90_M = { latCliente: 3.75491, lngCliente: 8.77990 };
const MAXIMA = 120;

test('con GPS bueno, el taxi va a la persona y no al supermercado de al lado', () => {
  const r = puntoDeRecogida(
    { ...SUPERMERCADO, ...A_90_M, precisionClienteM: 12 },
    MAXIMA,
  );
  assert.equal(r.origen, 'gps');
  assert.equal(r.lat, A_90_M.latCliente);
  // Y se dice a cuánto queda del sitio conocido, que es lo que deja a la app
  // del taxista decir «a 90 m de la Farmacia Nueva» en vez de plantar un pin
  // en medio de la nada y callarse.
  assert.ok(r.metrosDeLaReferencia !== null && Math.abs(r.metrosDeLaReferencia - 90) < 5,
    `esperaba ~90 m y salieron ${r.metrosDeLaReferencia}`);
});

test('con GPS malo se usa el sitio del catálogo: ±800 m no es un punto, es un barrio', () => {
  const r = puntoDeRecogida(
    { ...SUPERMERCADO, ...A_90_M, precisionClienteM: 800 },
    MAXIMA,
  );
  assert.equal(r.origen, 'referencia');
  assert.equal(r.lat, SUPERMERCADO.referenciaLat);
  // Aun descartada, se dice a cuánto estaba: es la señal de que algo no cuadra.
  assert.ok(r.metrosDeLaReferencia !== null);
});

test('sin precisión conocida no se usa la coordenada: NULL es «no se sabe», no «es buena»', () => {
  // Son las solicitudes anteriores a la 046, tomadas con el GPS flojo de
  // entonces. Usarlas a ciegas repetiría el fallo con datos peores.
  const r = puntoDeRecogida(
    { ...SUPERMERCADO, ...A_90_M, precisionClienteM: null },
    MAXIMA,
  );
  assert.equal(r.origen, 'referencia');
});

test('sin GPS ninguno, el catálogo es lo único que hay y no es un error', () => {
  const r = puntoDeRecogida(
    { ...SUPERMERCADO, latCliente: null, lngCliente: null, precisionClienteM: null },
    MAXIMA,
  );
  assert.equal(r.origen, 'referencia');
  assert.equal(r.metrosDeLaReferencia, null);
});

test('justo en el umbral se acepta: el límite es «peor que», no «igual a»', () => {
  assert.equal(
    puntoDeRecogida({ ...SUPERMERCADO, ...A_90_M, precisionClienteM: MAXIMA }, MAXIMA).origen,
    'gps',
  );
  assert.equal(
    puntoDeRecogida({ ...SUPERMERCADO, ...A_90_M, precisionClienteM: MAXIMA + 1 }, MAXIMA).origen,
    'referencia',
  );
});

test('quien pide desde el propio sitio del catálogo sale a cero metros, no a un metro raro', () => {
  const r = puntoDeRecogida(
    {
      ...SUPERMERCADO,
      latCliente: SUPERMERCADO.referenciaLat,
      lngCliente: SUPERMERCADO.referenciaLng,
      precisionClienteM: 9,
    },
    MAXIMA,
  );
  assert.equal(r.origen, 'gps');
  assert.ok((r.metrosDeLaReferencia ?? 1) < 0.5);
});
