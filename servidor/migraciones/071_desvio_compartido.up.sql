-- 071 — Cuánto cuesta desviarse a por otro pasajero, y cuándo no compensa
--        (P13-04: «sin límite de desvío»).
--
-- Hasta ahora, a un taxi con alguien dentro se le ofrecía cualquier carrera
-- que le cupiera y cuyo destino cayera por su zona. Nadie medía lo que eso le
-- costaba al que ya iba dentro, que no ha pedido nada y no puede bajarse.
--
-- EL DIAGNÓSTICO (26/09, `scripts/diagnostico-compartido.ts`, 300 escenarios
-- sobre el mapa real de Malabo y los sitios reales del catálogo):
--
--   · Conviene desviarse en el 52 % de los casos. En el 48 % no.
--   · El retraso del que va dentro es de todo o nada: mediana 0 min —cuando
--     el otro pilla de camino no cuesta nada— pero p90 de 11,6 min y peor
--     caso 12,6. Un viaje de diez minutos convertido en veintitrés.
--   · Con los límites de abajo, el 24 % de los desvíos que hoy se ofrecen
--     pasan del tope absoluto de retraso.
--   · El nuevo espera de mediana 4,9 min a que lo recojan (p90 11,4).
--   · Al taxista le cuesta 2,4 km de mediana.
--   · Y el orden de paradas cambia en el 35 % de los casos: el coche deja de
--     ir a donde iba.
--
-- LO QUE SE HACE CON ESO. Dos cosas, y la segunda importa tanto como la
-- primera:
--
--   1. No se ofrece el desvío que se pasa de los límites. Es la mitad de los
--      de hoy.
--   2. El que sí se ofrece llega CON SUS NÚMEROS: cuánto retrasa al de dentro
--      y cuántos kilómetros de más son. El taxista decide sabiendo; un
--      reparto que manda sin enseñar sus cuentas es el que nadie se cree.
--
-- Los tres límites salen de la tabla `parametro` y el operador los mueve sin
-- desplegar. `desvio_filtra` a 0 devuelve el comportamiento de antes: se
-- ofrece todo y los números se enseñan igual.

ALTER TABLE oferta
  ADD COLUMN desvio_retraso_seg integer,
  ADD COLUMN desvio_espera_seg integer,
  ADD COLUMN desvio_metros integer;

COMMENT ON COLUMN oferta.desvio_retraso_seg IS
  'Lo que esta carrera le alargaría el viaje al pasajero que peor sale '
  'parado, en segundos (migración 071). NULL si el coche iba vacío.';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('desvio_filtra', '1',
   'Si a 1, no se ofrece una carrera al taxi que ya lleva pasaje cuando el '
   'desvío se pasa de los límites de abajo (migración 071)'),
  ('desvio_retraso_max_seg', '300',
   'Lo que como mucho se le puede alargar el viaje a quien ya va dentro'),
  ('desvio_retraso_max_pct', '50',
   'Y lo mismo en proporción: 50 = no se le puede alargar el viaje más de la '
   'mitad de lo que le quedaba. Manda el que primero se pase'),
  ('desvio_espera_max_seg', '480',
   'Lo que como mucho puede esperar el nuevo a que lo recojan. Más que esto '
   'y le sirve más otro taxi, aunque al taxista le venga de paso');
