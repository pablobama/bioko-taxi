-- 012 — Revertir: devolver las columnas de precio reportado
--
-- Los valores anteriores no se recuperan (la migración up los elimina).

ALTER TABLE viaje
  ADD COLUMN precio_reportado_cliente integer,
  ADD COLUMN precio_reportado_conductor integer;

COMMENT ON TABLE banda_precio IS NULL;
