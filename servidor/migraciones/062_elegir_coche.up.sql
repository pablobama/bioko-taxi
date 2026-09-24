-- 062 — El pasajero puede elegir el coche que quiere.
--
-- Hasta ahora el reparto era ciego por diseño: el pasajero pedía y el sistema
-- ofrecía la carrera a los taxistas del barrio en oleadas; el primero que la
-- reclamaba se la llevaba. Es lo justo para el taxista y lo más rápido para
-- llenar el coche, pero el pasajero no elegía nada: ni el coche, ni si venía
-- en dos minutos o en doce.
--
-- Ahora puede elegir uno de los que podrían venir, con su tiempo estimado
-- delante. Y se respeta así:
--
--   Oleada 0  t=0   SOLO al coche elegido.
--   t=oleada_elegido_seg  si no lo ha cogido, empiezan las oleadas de siempre.
--
-- Es una preferencia, no una reserva: nadie puede obligar a un taxista a
-- aceptar. Si no contesta en veinte segundos, la carrera sigue su camino
-- normal y el pasajero no se queda esperando por una elección que no salió.
--
-- LO QUE NO CAMBIA: al pasajero no se le da ninguna posición para elegir. Ve
-- qué coche es, cómo lo valoran y cuánto tardaría; nunca dónde está. La regla
-- de la migración 023 sigue entera, y un tiempo estimado no se puede seguir
-- por un mapa.

ALTER TABLE solicitud
  ADD COLUMN conductor_elegido_id bigint REFERENCES conductor (id);

COMMENT ON COLUMN solicitud.conductor_elegido_id IS
  'Taxista que el pasajero eligió al pedir (migración 062). Recibe la carrera '
  'en exclusiva durante oleada_elegido_seg; después, reparto normal.';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('oleada_elegido_seg', '20',
   'Segundos que el coche elegido por el pasajero tiene la carrera en '
   'exclusiva antes de que empiece el reparto normal (migración 062)');

-- La oleada 0 necesita sitio en el CHECK, que admitía 1..4 desde la 048.
ALTER TABLE oferta DROP CONSTRAINT oferta_oleada_check;
ALTER TABLE oferta ADD CONSTRAINT oferta_oleada_check CHECK (oleada BETWEEN 0 AND 4);
