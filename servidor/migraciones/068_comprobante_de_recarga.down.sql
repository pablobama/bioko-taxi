DROP INDEX recarga_comprobante_unico;
ALTER TABLE recarga DROP COLUMN comprobante;
DELETE FROM parametro WHERE clave = 'recarga_exige_comprobante';
