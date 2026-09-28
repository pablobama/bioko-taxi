-- 074 — Lo que dijeron los datos de producción, y la marcha atrás (28/09).
--
-- La 073 cambió el tiempo hasta destino: en vez de dividir distancia por una
-- velocidad, pasaba a usar el tiempo que el plano da a esas calles corregido
-- por un factor del taxista. El razonamiento era bueno y el resultado, peor.
--
-- MEDIDO SOBRE 42 VIAJES DE PRODUCCIÓN (`scripts/diagnostico-eta.ts 30`):
--
--   Error medio ANTES (el cálculo de siempre) ..... −0,5 min
--   Error medio con la 073 ........................ +8,0 min
--
-- El cálculo de siempre estaba bien calibrado: viaje tras viaje clavaba el
-- tiempo con menos de un minuto de diferencia (6 vs 6,4 · 5 vs 5,3 · 10 vs
-- 10,4 · 11 vs 11,6 · 7 vs 7,0). El de la 073 se pasaba de largo casi siempre,
-- y por un motivo concreto: el factor del taxista salía entre 0,63 y 0,86
-- —o sea «va más lento que el plano»— porque dentro de ese factor YA estaban
-- los semáforos, y encima se le sumaba la holgura del 15 %. Se contaban las
-- paradas dos veces.
--
-- Así que `eta_usa_plano` pasa a 0. El código se queda —está probado y el
-- interruptor permite volver a intentarlo— pero apagado hasta que haya una
-- razón medida para encenderlo.
--
-- LO QUE SÍ ERA VERDAD, y es lo que esta migración arregla. El caso que
-- empezó todo —7 km marcados en 35 minutos— aparece en los datos: el viaje 39,
-- 6,5 km, 39 minutos anunciados. Y tiene una marca propia: la velocidad venía
-- del TURNO, no del viaje. Pasa al empezar, cuando el viaje todavía no tiene
-- dos posiciones propias.
--
-- La velocidad del turno es kilómetros partido por tiempo transcurrido, y un
-- taxista pasa buena parte del turno ESPERANDO: en la parada, delante del
-- portal, a que salga el pasajero. Esa espera hunde la media hasta el suelo de
-- 8 km/h, y 6,5 km a 8 km/h son 39 minutos exactos.
--
-- Ahora las esperas LARGAS no cuentan como tiempo de viaje. Las cortas sí, y
-- eso es a propósito: un semáforo es parte de conducir y tiene que estar
-- dentro del número; estar veinte minutos parado en la parada del mercado, no.
-- La frontera es `eta_espera_maxima_seg`.

UPDATE parametro SET valor = '0' WHERE clave = 'eta_usa_plano';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('eta_espera_maxima_seg', '90',
   'Un rato parado más largo que esto no cuenta para medir a qué velocidad va '
   'un taxista: es espera, no tráfico (migración 074). Los semáforos y los '
   'atascos sí cuentan, que son parte de conducir');
