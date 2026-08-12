DELETE FROM parametro WHERE clave = 'recogida_precision_maxima_m';

ALTER TABLE solicitud DROP COLUMN precision_cliente_m;
