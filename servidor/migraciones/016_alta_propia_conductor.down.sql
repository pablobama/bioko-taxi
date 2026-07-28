-- 016 — Revertir alta propia del conductor

ALTER TABLE conductor DROP COLUMN IF EXISTS correo;
ALTER TABLE vehiculo DROP COLUMN IF EXISTS carroceria;
