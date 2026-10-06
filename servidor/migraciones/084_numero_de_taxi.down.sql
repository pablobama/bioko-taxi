DELETE FROM parametro WHERE clave = 'numero_taxi_siguiente';
DROP INDEX IF EXISTS conductor_numero_taxi;
ALTER TABLE conductor DROP COLUMN IF EXISTS numero_taxi;
