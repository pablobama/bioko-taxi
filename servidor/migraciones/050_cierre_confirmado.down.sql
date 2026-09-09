DELETE FROM parametro
 WHERE clave IN ('gps_separacion_sostenida_seg', 'gps_cierre_minimo_viaje_seg');

ALTER TABLE viaje DROP COLUMN separado_desde;
