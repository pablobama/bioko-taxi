DELETE FROM parametro
 WHERE clave IN ('rastro_ruido_m', 'rastro_velocidad_maxima_kmh', 'rastro_lote_maximo');

DROP INDEX rastro_sin_repetidos;

ALTER TABLE transicion DROP COLUMN ocurrio_en;
