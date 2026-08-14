DELETE FROM parametro
 WHERE clave IN ('gps_precision_supuesta_m', 'gps_precision_maxima_decision_m');

ALTER TABLE posicion DROP COLUMN precision_m;
