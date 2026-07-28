-- 009 — Revertir soporte de «he llegado» y saldo bajo

DELETE FROM parametro WHERE clave = 'umbral_saldo_bajo_xaf';
ALTER TABLE viaje DROP COLUMN IF EXISTS llegado_en;
