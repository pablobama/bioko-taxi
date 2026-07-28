-- 008 — Revertir buzón de salida de eventos

DELETE FROM parametro WHERE clave = 'eventos_max_intentos';
DROP TABLE IF EXISTS evento_salida;
