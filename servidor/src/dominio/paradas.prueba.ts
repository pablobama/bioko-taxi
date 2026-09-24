// Pruebas del orden de paradas del taxi compartido. Puras: sin base de datos.
//
// Ejecutar: npm run probar

import test from 'node:test';
import assert from 'node:assert/strict';
import { ordenarParadas, type ParadaPendiente } from './paradas.js';

// Un eje de metros hacia el este, para poder razonar en distancias redondas.
const EN = (metrosAlEste: number) => ({ lat: 3.75, lng: 8.78 + metrosAlEste / 111_000 });

const parada = (
  solicitudId: number,
  tipo: 'recogida' | 'destino',
  metrosAlEste: number,
): ParadaPendiente => ({ solicitudId, tipo, nombre: `${tipo} ${solicitudId}`, ...EN(metrosAlEste) });

const nombres = (lista: ParadaPendiente[]) => lista.map((p) => `${p.tipo}${p.solicitudId}`);

test('el que se baja antes va antes, aunque subiera el último', () => {
  // El caso que lo pidió: el pasajero 1 subió primero y se baja a 4 km; el
  // pasajero 2 subió después y se baja a 300 m. Antes la guía llevaba al
  // taxista a 4 km con el otro dentro, pasando de largo por su puerta.
  const coche = EN(0);
  const paradas = [parada(1, 'destino', 4000), parada(2, 'destino', 300)];
  assert.deepEqual(nombres(ordenarParadas(coche, paradas)), ['destino2', 'destino1']);
});

test('a nadie se le deja antes de subirlo', () => {
  // El destino del pasajero 3 está pegado al coche, pero todavía no ha subido:
  // primero hay que ir a por él, esté donde esté.
  const coche = EN(0);
  const paradas = [parada(3, 'recogida', 2000), parada(3, 'destino', 50)];
  assert.deepEqual(nombres(ordenarParadas(coche, paradas)), ['recogida3', 'destino3']);
});

test('recogidas y destinos se mezclan por cercanía', () => {
  // Va uno dentro que se baja a 1 km, y hay que recoger a otro a 200 m que se
  // baja a 1,2 km: se recoge al de 200 m de camino, y luego los dos destinos
  // en el orden en que aparecen.
  const coche = EN(0);
  const paradas = [
    parada(1, 'destino', 1000),
    parada(2, 'recogida', 200),
    parada(2, 'destino', 1200),
  ];
  assert.deepEqual(
    nombres(ordenarParadas(coche, paradas)),
    ['recogida2', 'destino1', 'destino2'],
  );
});

test('sin saber dónde está el coche no se reordena nada', () => {
  // Un taxista que todavía no ha mandado posición. Inventar un orden sin saber
  // de dónde parte sería peor que dejar el que hay.
  const paradas = [parada(1, 'destino', 4000), parada(2, 'destino', 300)];
  assert.deepEqual(nombres(ordenarParadas(null, paradas)), ['destino1', 'destino2']);
});

test('el orden se mide con el medidor que se le pase, no en línea recta', () => {
  // En Malabo dos puntos a la misma distancia recta pueden estar a cinco
  // minutos o a veinte, según los sentidos únicos. Quien llama mide por las
  // calles; aquí se comprueba que ese medidor es el que manda.
  const coche = EN(0);
  const paradas = [parada(1, 'destino', 300), parada(2, 'destino', 400)];
  // Un medidor que dice que el 2 está más cerca aunque en recta esté más lejos.
  const alReves = (desde: { lat: number; lng: number }, hasta: { lat: number; lng: number }) =>
    1 / (Math.abs(hasta.lng - desde.lng) + 1e-9);
  assert.deepEqual(nombres(ordenarParadas(coche, paradas, alReves)), ['destino2', 'destino1']);
});

test('una sola parada se devuelve tal cual', () => {
  const paradas = [parada(1, 'destino', 500)];
  assert.deepEqual(nombres(ordenarParadas(EN(0), paradas)), ['destino1']);
});
