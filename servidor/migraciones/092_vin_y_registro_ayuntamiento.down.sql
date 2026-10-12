DELETE FROM parametro WHERE clave = 'registro_ayuntamiento_xaf';
ALTER TABLE conductor DROP COLUMN tipo_registro;
ALTER TABLE vehiculo DROP COLUMN vin;
