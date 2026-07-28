-- 014 — Mapa de proximidad, tiempo estimado y reputación del conductor
-- (decisión de sesión, 2026-07-26).
--
-- Revierte el no-objetivo «no hay mapa interactivo con taxis en movimiento»
-- de la sección 14, por decisión explícita. Con matices honestos:
--
-- 1. NO hay cartografía de calles. El mapa se dibuja en el cliente como SVG a
--    partir de las coordenadas reales del gazetteer: es un esquema veraz de
--    puntos y zonas, no un plano callejero. Coste de datos ~ cero (no hay
--    baldosas que descargar; van coordenadas en el JSON que ya se pedía).
--
-- 2. El tiempo estimado NO usa motor de rutas: es distancia en línea recta
--    entre la última posición del coche y el punto de recogida, dividida por
--    una velocidad urbana media parametrizable. Es aproximado y la interfaz
--    lo dice.
--
-- 3. El cliente pasa a ver la posición del conductor mientras se acerca.
--    Antes no la veía. Solo durante ACEPTADO y EN_CAMINO.

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('velocidad_urbana_kmh', '18',
   'Velocidad media supuesta para estimar el tiempo de llegada (sin motor de rutas)'),
  ('eta_factor_desvio', '13',
   'Multiplicador en décimas sobre la distancia recta para compensar que las calles no son rectas (13 = x1,3)');

-- La reputación se calcula sobre valoraciones de viajes reales; este índice la
-- hace barata de consultar por conductor.
CREATE INDEX valoracion_por_conductor ON valoracion (viaje_id)
  WHERE emisor = 'cliente';
