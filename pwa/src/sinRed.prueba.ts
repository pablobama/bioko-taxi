// La bandeja de acciones hechas sin red (migración 057).
//
// Ejecutar: npm run probar   (desde /pwa)

import test from 'node:test';
import assert from 'node:assert/strict';
import { procesarBandeja, type AccionPendiente } from './sinRed.js';

class ErrorDeRedFalso extends Error {}
class ErrorServidorFalso extends Error {
  constructor(readonly estado: number, mensaje: string) { super(mensaje); }
}
const esRed = (e: unknown) => e instanceof ErrorDeRedFalso;

const accion = (id: number, ruta: string): AccionPendiente => ({
  id, ruta, cuerpo: {}, pulsadaEn: `2026-09-15T10:0${id}:00.000Z`, descripcion: ruta,
});

test('todo llega: se borra todo, en orden, y cada una con su hora', async () => {
  const enviadas: Array<[string, unknown]> = [];
  const { borrar, resultado } = await procesarBandeja(
    [accion(1, 'recoger'), accion(2, 'completar')],
    async (ruta, cuerpo) => { enviadas.push([ruta, cuerpo.ocurridoEn]); },
    esRed,
  );
  assert.deepEqual(enviadas, [['recoger', '2026-09-15T10:01:00.000Z'], ['completar', '2026-09-15T10:02:00.000Z']]);
  assert.deepEqual(borrar, [1, 2]);
  assert.equal(resultado.enviadas, 2);
});

test('se va la red a mitad: se para AHÍ, no se salta a la siguiente', async () => {
  // «Viaje terminado» no puede llegar antes que «pasajero recogido».
  const enviadas: string[] = [];
  const { borrar, resultado } = await procesarBandeja(
    [accion(1, 'salir'), accion(2, 'recoger'), accion(3, 'completar')],
    async (ruta) => {
      if (ruta === 'recoger') throw new ErrorDeRedFalso();
      enviadas.push(ruta);
    },
    esRed,
  );
  assert.deepEqual(enviadas, ['salir'], 'completar NO se manda');
  assert.deepEqual(borrar, [1], 'recoger y completar se quedan para el próximo intento');
  assert.equal(resultado.quedan, 2);
});

test('el servidor falla (5xx): tampoco se salta, se reintenta luego', async () => {
  const { borrar, resultado } = await procesarBandeja(
    [accion(1, 'recoger'), accion(2, 'completar')],
    async (ruta) => { if (ruta === 'recoger') throw new ErrorServidorFalso(503, 'caído'); },
    esRed,
  );
  assert.deepEqual(borrar, []);
  assert.equal(resultado.quedan, 2);
});

test('lo que ya no tiene arreglo (4xx) se descarta, se cuenta, y se sigue', async () => {
  const { borrar, resultado } = await procesarBandeja(
    [accion(1, 'salir'), accion(2, 'valoracion')],
    async (ruta) => { if (ruta === 'salir') throw new ErrorServidorFalso(409, 'el pasajero canceló'); },
    esRed,
  );
  assert.deepEqual(borrar, [1, 2]);
  assert.equal(resultado.rechazadas.length, 1);
  assert.match(resultado.rechazadas[0].motivo, /canceló/);
  assert.equal(resultado.enviadas, 1);
});

test('un error sin código ni de red se trata como red: nunca se pierde una acción por un fallo raro', async () => {
  const { borrar } = await procesarBandeja(
    [accion(1, 'completar')],
    async () => { throw new TypeError('algo raro'); },
    esRed,
  );
  assert.deepEqual(borrar, [], 'se guarda para reintentar');
});
