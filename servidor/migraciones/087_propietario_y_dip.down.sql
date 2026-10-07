ALTER TABLE vehiculo DROP CONSTRAINT vehiculo_carroceria_check;
ALTER TABLE vehiculo ADD CONSTRAINT vehiculo_carroceria_check
  CHECK (carroceria IN ('turismo', '4x4'));
DROP INDEX IF EXISTS vehiculo_propietario;
ALTER TABLE vehiculo DROP COLUMN IF EXISTS propietario_id;
DROP INDEX IF EXISTS conductor_dip;
ALTER TABLE conductor DROP COLUMN IF EXISTS dip;
ALTER TABLE conductor DROP COLUMN IF EXISTS apellido;
DROP TABLE IF EXISTS propietario;
