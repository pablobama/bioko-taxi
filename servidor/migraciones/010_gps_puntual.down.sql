-- 010 — Revertir GPS puntual

ALTER TABLE viaje
  DROP COLUMN IF EXISTS distancia_validacion_m,
  DROP COLUMN IF EXISTS lng_validacion,
  DROP COLUMN IF EXISTS lat_validacion,
  DROP COLUMN IF EXISTS lng_llegada,
  DROP COLUMN IF EXISTS lat_llegada;

ALTER TABLE solicitud
  DROP COLUMN IF EXISTS lng_cliente,
  DROP COLUMN IF EXISTS lat_cliente;
