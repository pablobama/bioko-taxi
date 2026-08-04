-- 038 — Revertir la fijación limpia.

ALTER TABLE zona DROP COLUMN IF EXISTS referencia_id;
ALTER TABLE referencia DROP COLUMN IF EXISTS precision_gps_m;
