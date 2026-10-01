-- 077 — La radio también suena con la aplicación cerrada (02/10).
--
-- EL HUECO QUE TAPA. Los mensajes de voz del gremio llegaban solo por la
-- conexión abierta, así que con la aplicación en segundo plano —el teléfono en
-- el bolsillo, que es donde está casi siempre— el taxista no se enteraba de
-- nada. La radio funcionaba únicamente mirando la pantalla, que es justo lo que
-- no se puede hacer conduciendo.
--
-- LA MISMA REGLA QUE LAS CARRERAS, y es lo que impide que esto sea ruido: el
-- aviso NO sale si hay alguien mirando. Con la pantalla delante ya suena el
-- mensaje en la propia página, y una notificación encima de lo que ya se está
-- viendo es la forma más rápida de que alguien apague los avisos — y al
-- apagarlos pierde también las carreras.
--
-- Así que canal 1 la conexión abierta, canal 2 la notificación. Exactamente el
-- mismo camino que `D1_broadcast_solicitud`.
--
-- `ttl_seg` 120, y es corto a propósito: un mensaje de voz de hace cinco
-- minutos ya no es una conversación, es un recado viejo. Que suene entonces
-- solo sirve para molestar; el mensaje sigue en la lista para quien quiera
-- oírlo.
--
-- LO QUE NO HACE, dicho claro: la notificación AVISA de que alguien ha hablado,
-- no reproduce la voz. Un service worker no puede sonar por su cuenta, y iOS no
-- deja reproducir audio sin que el usuario toque algo. Así que dice quién ha
-- hablado y al tocarla se abre la aplicación con el mensaje listo. No es manos
-- libres —eso solo lo da la app de Android— pero es la diferencia entre
-- enterarse y no enterarse.

INSERT INTO enrutamiento (evento, rol, canal_1, canal_2, condicion_escalada, ttl_seg) VALUES
  ('D8_radio_mensaje', 'conductor', 'sse', 'web', NULL, 120);

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('radio_aviso_push', '1',
   'Interruptor del aviso de los mensajes de la radio con la aplicación '
   'cerrada (migración 077). A 0, la radio vuelve a sonar solo con la pantalla '
   'delante. Está por si el gremio decide que son demasiados avisos');
