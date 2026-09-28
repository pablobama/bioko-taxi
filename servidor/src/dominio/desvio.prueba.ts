// Pruebas del desvío del taxi compartido. Sin base de datos: el medidor se
// inyecta, así que el mapa es de mentira y las cuentas se pueden comprobar a
// mano.
//
// Ejecutar: npm run probar

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluarDesvio, type Limites, type MedidorViaje } from './desvio.js';
import type { ParadaPendiente } from './paradas.js';

// Un mapa de mentira, pero honesto: la distancia es la recta en «grados de
// mentira» (1 unidad = 100 m) y se va a 36 km/h, o sea 10 m/s. Así los números
// de las pruebas se pueden hacer con la cabeza.
const medir: MedidorViaje = (a, b) => {
  const metros = Math.hypot(a.lat - b.lat, a.lng - b.lng) * 100;
  return { metros, segundos: metros / 10 };
};

const LIMITES: Limites = {
  retrasoMaximoSeg: 300,
  retrasoMaximoPorcentaje: 0.5,
  esperaMaximaNuevoSeg: 480,
};

const parada = (
  solicitudId: number, tipo: 'recogida' | 'destino', lat: number, lng: number,
): ParadaPendiente => ({ solicitudId, tipo, lat, lng, nombre: `${tipo} ${solicitudId}` });

test('de paso y sin retraso: el desvío conviene', () => {
  // El que va dentro se baja al final de la calle; el nuevo está justo al lado
  // del camino. Es el caso para el que existe el taxi compartido.
  const veredicto = evaluarDesvio(
    { lat: 0, lng: 0 },
    [parada(1, 'destino', 20, 0)],
    { solicitudId: 2, recogida: { lat: 8, lng: 0.5 }, destino: { lat: 18, lng: 0.5 } },
    medir,
    LIMITES,
  );
  assert.equal(veredicto.conviene, true);
  assert.equal(veredicto.motivo, 'cabe');
  assert.ok(veredicto.retrasoMaximoSeg < 60, `retraso ${veredicto.retrasoMaximoSeg}`);
});

test('el nuevo tira del coche hacia el otro lado: no se desvía, y se dice por qué', () => {
  // Quien va dentro se baja a 2 km hacia el norte. El nuevo espera a 1,8 km
  // hacia el sur y se baja todavía más al sur, así que el coche va a por él
  // primero —está más cerca— y el de dentro acaba dando toda la vuelta: de
  // 200 s de viaje a 660.
  //
  // Nótese que el caso «el nuevo está lejos» NO es este. Si el de dentro se
  // baja antes de llegar a él, el orden lo deja primero y no se le retrasa
  // nada: lo caro entonces es la espera del nuevo y la gasolina, no su viaje.
  const veredicto = evaluarDesvio(
    { lat: 0, lng: 0 },
    [parada(1, 'destino', 20, 0)],
    { solicitudId: 2, recogida: { lat: -18, lng: 0 }, destino: { lat: -30, lng: 0 } },
    medir,
    LIMITES,
  );
  assert.equal(veredicto.conviene, false);
  assert.equal(veredicto.motivo, 'retrasa_demasiado');
  assert.ok(veredicto.retrasoMaximoSeg > 300, `retraso ${veredicto.retrasoMaximoSeg}`);
});

test('el retraso se mide también en proporción: minuto y medio sobre tres minutos no vale', () => {
  // Retraso por debajo del tope absoluto (menos de 300 s) y aun así medio
  // viaje más: el de dentro iba a 200 s de bajarse y acaba en 309.
  const veredicto = evaluarDesvio(
    { lat: 0, lng: 0 },
    [parada(1, 'destino', 20, 0)],
    { solicitudId: 2, recogida: { lat: -9, lng: 0 }, destino: { lat: 24, lng: 0 } },
    medir,
    LIMITES,
  );
  assert.equal(veredicto.conviene, false);
  assert.equal(veredicto.motivo, 'retrasa_demasiado');
  assert.ok(veredicto.retrasoMaximoSeg <= LIMITES.retrasoMaximoSeg,
    `el tope absoluto no se pasa (${veredicto.retrasoMaximoSeg} s): lo que falla es la proporción`);
});

test('si el nuevo va a esperar demasiado, tampoco: le sirve más otro taxi', () => {
  // El taxi tiene que dejar a dos personas antes de poder ir a por él, y va en
  // la misma dirección, así que a nadie se le retrasa nada — pero el nuevo se
  // queda diez minutos en la acera.
  const veredicto = evaluarDesvio(
    { lat: 0, lng: 0 },
    [parada(1, 'destino', 40, 0), parada(3, 'destino', 80, 0)],
    { solicitudId: 2, recogida: { lat: 90, lng: 0 }, destino: { lat: 95, lng: 0 } },
    medir,
    { ...LIMITES, retrasoMaximoSeg: 3600, retrasoMaximoPorcentaje: 10 },
  );
  assert.equal(veredicto.conviene, false);
  assert.equal(veredicto.motivo, 'espera_demasiado');
  assert.ok(veredicto.esperaNuevoSeg > 480);
});

test('el coche vacío siempre puede: no hay a quién retrasar', () => {
  const veredicto = evaluarDesvio(
    { lat: 0, lng: 0 },
    [],
    { solicitudId: 2, recogida: { lat: 10, lng: 0 }, destino: { lat: 30, lng: 0 } },
    medir,
    LIMITES,
  );
  assert.equal(veredicto.conviene, true);
  assert.equal(veredicto.retrasoMaximoSeg, 0);
  assert.equal(veredicto.metrosExtra > 0, true, 'kilómetros sí hace: son los suyos, no un desvío');
});

test('a nadie se le deja antes de subirlo, ni siquiera para ahorrar camino', () => {
  // La recogida del nuevo queda más lejos que su destino. El orden tiene que
  // respetar que primero se sube y después se baja.
  const veredicto = evaluarDesvio(
    { lat: 0, lng: 0 },
    [],
    { solicitudId: 2, recogida: { lat: 20, lng: 0 }, destino: { lat: 5, lng: 0 } },
    medir,
    LIMITES,
  );
  const tipos = veredicto.orden.map((p) => p.tipo);
  assert.deepEqual(tipos, ['recogida', 'destino']);
});

test('los números salen aunque el veredicto sea que no: son para enseñarlos', () => {
  const veredicto = evaluarDesvio(
    { lat: 0, lng: 0 },
    [parada(1, 'destino', 20, 0)],
    { solicitudId: 2, recogida: { lat: -18, lng: 0 }, destino: { lat: -30, lng: 0 } },
    medir,
    LIMITES,
  );
  assert.equal(veredicto.conviene, false);
  assert.ok(veredicto.metrosExtra > 0);
  assert.ok(Number.isFinite(veredicto.esperaNuevoSeg));
  assert.ok(veredicto.orden.length === 3, 'el plan B completo, para poder enseñarlo');
});
