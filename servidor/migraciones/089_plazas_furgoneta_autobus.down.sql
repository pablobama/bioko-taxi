-- Volver al tope de 4 de la migración 013. Los coches con más plazas se
-- recortan primero, o el CHECK no podría crearse.
ALTER TABLE vehiculo DROP CONSTRAINT IF EXISTS vehiculo_plazas_check;
UPDATE vehiculo SET plazas = 4 WHERE plazas > 4;
ALTER TABLE vehiculo ADD CONSTRAINT vehiculo_plazas_check CHECK (plazas BETWEEN 1 AND 4);
