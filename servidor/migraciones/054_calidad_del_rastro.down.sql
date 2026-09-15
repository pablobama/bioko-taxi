DELETE FROM parametro
 WHERE clave IN ('rastro_precision_maxima_m', 'latido_desfase_maximo_seg');

ALTER TABLE rastro DROP COLUMN precision_m;
