-- 028 — Revertir aire acondicionado y seguro.

ALTER TABLE vehiculo
  DROP COLUMN IF EXISTS aire_acondicionado,
  DROP COLUMN IF EXISTS seguro;
