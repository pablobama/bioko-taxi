// Lo que ve la persona cuando Twilio falla (06/10). No hace falta base de
// datos: se suplanta `fetch` y se comprueba qué error sale hacia la pantalla.
//
// El caso que lo motivó es real: el canal de llamada estaba apagado en la
// consola de Twilio, Verify contestaba «Delivery channel disabled» con el
// código 60223, y ese texto en inglés viajaba entero hasta el teléfono de
// quien intentaba entrar.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorDeTwilio, ServicioVerificacionTwilio } from './verificacion-telefono.js';

const fetchDeVerdad = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchDeVerdad; });

function twilioQueContesta(estado: number, cuerpo: unknown): ServicioVerificacionTwilio {
  globalThis.fetch = async () => new Response(JSON.stringify(cuerpo), { status: estado });
  return new ServicioVerificacionTwilio('AC0', 'token', 'VA0');
}

test('un fallo de Twilio sale como «dile este número de avería», no en crudo', async () => {
  const servicio = twilioQueContesta(403, {
    code: 60223, message: 'Delivery channel disabled: call',
  });
  await assert.rejects(
    () => servicio.enviarCodigo('+240222508227', 'llamada'),
    (error: unknown) => {
      assert.ok(error instanceof ErrorDeTwilio);
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /número de avería: 60223/);
      // Y NI RASTRO del texto de Twilio: es lo que se estaba filtrando.
      assert.ok(!error.message.includes('Delivery channel'));
      return true;
    },
  );
});

test('sin código de Twilio en la respuesta, el número de avería es el estado HTTP', async () => {
  const servicio = twilioQueContesta(500, { message: 'otra cosa' });
  await assert.rejects(
    () => servicio.enviarCodigo('+240222508227'),
    (error: unknown) => {
      assert.ok(error instanceof ErrorDeTwilio);
      assert.match(error.message, /número de avería: 500/);
      return true;
    },
  );
});

test('una verificación caducada es «código incorrecto», no una avería', async () => {
  const servicio = twilioQueContesta(404, { code: 20404, message: 'not found' });
  assert.equal(await servicio.comprobarCodigo('+240222508227', '123456'), false);
});
