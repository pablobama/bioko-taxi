-- 010 — GPS puntual como señal antifraude (decisión de sesión, 2026-07-26).
--
-- NO es seguimiento continuo (sigue prohibido por los no-objetivos): son
-- lecturas únicas en tres momentos — el cliente al pedir (si da permiso),
-- el conductor al pulsar «he llegado» y al validar el PIN. El PIN sigue
-- siendo la puerta de validación; las discrepancias de distancia alimentan
-- la detección de fraude del paso 10, nunca bloquean al conductor.

ALTER TABLE solicitud
  ADD COLUMN lat_cliente double precision,
  ADD COLUMN lng_cliente double precision;

ALTER TABLE viaje
  ADD COLUMN lat_llegada double precision,
  ADD COLUMN lng_llegada double precision,
  ADD COLUMN lat_validacion double precision,
  ADD COLUMN lng_validacion double precision,
  -- Distancia en metros entre la lectura del conductor al validar y la
  -- referencia de origen. Calculada al validar; NULL si no hubo lectura.
  ADD COLUMN distancia_validacion_m integer;
