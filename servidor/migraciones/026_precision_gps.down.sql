-- 026 — Revertir la comprobación de precisión del GPS.

DELETE FROM parametro WHERE clave = 'gps_precision_maxima_m';

ALTER TABLE zona DROP COLUMN IF EXISTS precision_gps_m;
