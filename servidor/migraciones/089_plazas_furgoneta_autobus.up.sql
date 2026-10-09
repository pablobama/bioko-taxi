-- 089 — Más plazas para furgoneta y autobús (09/10).
--
-- La migración 013 (taxi compartido) puso `plazas BETWEEN 1 AND 4`, que valía
-- cuando todos los coches eran turismos. Con la 087 entraron la furgoneta y el
-- autobús, que llevan bastante más gente, y el tope de 4 les quedaba corto: una
-- furgoneta registrada con 4 plazas se da por llena a la cuarta persona.
--
-- Se amplía el rango de la BASE a 1-60 (un autobús urbano no pasa de ahí). El
-- tope POR TIPO —un turismo sigue siendo de 4— lo pone el servidor, no la base:
-- es una regla de negocio que cambia más que el esquema, y meterla en un CHECK
-- obligaría a una migración cada vez que se afine.
--
-- La lógica del taxi compartido escala sola: «coche lleno» es
-- `ocupadas < plazas` (dominio/ocupacion.ts, despacho.ts, cobertura.ts) y el
-- orden de paradas es voraz, no el viajante (dominio/paradas.ts) —así que más
-- plazas no disparan el coste—.

ALTER TABLE vehiculo DROP CONSTRAINT IF EXISTS vehiculo_plazas_check;
ALTER TABLE vehiculo ADD CONSTRAINT vehiculo_plazas_check CHECK (plazas BETWEEN 1 AND 60);

COMMENT ON COLUMN vehiculo.plazas IS
  'Plazas de pasajero del taxi compartido (migración 013). Rango de la base '
  '1-60 (migración 089); el tope por tipo de vehículo lo pone el servidor.';
