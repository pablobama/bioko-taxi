-- 050 — Un viaje no se cierra por UNA lectura de GPS.
--
-- Hoy, en pleno viaje, un servicio se dio por terminado con el pasajero
-- todavía sentado en el coche. Es la segunda vez.
--
-- La 047 puso márgenes de error alrededor de cada punto, y estaba bien, pero
-- no atacaba la raíz: la decisión se sigue tomando con UNA lectura de cada
-- lado. Y el GPS de un móvil dentro de un coche en marcha, entre edificios,
-- suelta de vez en cuando una fijación disparada a cientos de metros —y la
-- acompaña de una precisión optimista, porque el chip no sabe que se ha
-- equivocado—. Ninguna cantidad de margen protege contra eso: el margen
-- ensancha el punto, no detecta la mentira.
--
-- Lo que sí la detecta es el tiempo. El pasajero va DENTRO del coche: la
-- separación real no es un instante, es una situación que se queda —se bajó y
-- el coche se fue—. Una fijación mala, en cambio, dura una lectura y a la
-- siguiente vuelve a su sitio. Así que ahora la separación tiene que
-- SOSTENERSE antes de cerrar nada.
--
-- Coste de esperar: el viaje se cierra un minuto y medio más tarde de lo que
-- podría. No le pasa nada a nadie; el taxista además tiene su botón.
-- Coste de no esperar: el que se ha visto dos veces.

ALTER TABLE viaje
  ADD COLUMN separado_desde timestamptz;

COMMENT ON COLUMN viaje.separado_desde IS
  'Desde cuándo se ve al pasajero lejos del coche, sin interrupción '
  '(migración 050). Se borra en cuanto vuelven a verse juntos. El cierre '
  'automático necesita que aguante gps_separacion_sostenida_seg.';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('gps_separacion_sostenida_seg', '90',
   'Cuánto tiene que aguantar la separación antes de cerrar el viaje sola. '
   'Protege contra la fijación disparada de un GPS urbano, que dura una '
   'lectura'),
  ('gps_cierre_minimo_viaje_seg', '120',
   'Tiempo mínimo desde la recogida antes de que el cierre automático pueda '
   'actuar. Justo después de subir es cuando el chip está peor asentado y '
   'cuando un cierre en falso más se nota');
