-- 057 — El taxista puede seguir trabajando sin red.
--
-- En Malabo la cobertura va y viene, y el sitio donde más falta —el portal de
-- una casa, un parking, la subida a Basilé— es justo donde se recoge y se deja
-- al pasajero. Hasta ahora, sin red, «pasajero recogido» o «viaje terminado»
-- daban error y no se guardaban en ningún sitio: el viaje se quedaba abierto,
-- el taxista ocupado para el reparto, y las horas de los hechos perdidas.
--
-- Ahora la aplicación los guarda y los manda cuando vuelve la red, con la HORA
-- EN QUE SE PULSARON. De esta migración, en la base, solo hace falta el tope de
-- cuánto atrás se le cree esa hora; lo demás es código:
--
--   - Cada acción es REPETIBLE. Si llega tarde y el viaje ya avanzó por su
--     cuenta —la proximidad GPS recogió al pasajero, o el cierre automático
--     lo terminó—, no es un error: es que ya estaba hecho. Antes, sí lo era.
--   - La hora del hecho va a `transicion.ocurrio_en` (051), y nunca queda por
--     detrás del último cambio ya apuntado de la misma entidad.
--   - Lo que ya no tiene arreglo —el pasajero canceló mientras tanto— se
--     contesta con un 409 que la aplicación enseña y descarta.
--
-- Lo que NO se puede hacer sin red, y a propósito: pedir un taxi, aceptar una
-- carrera y cancelar. Las tres son decisiones que valen AHORA; hechas veinte
-- minutos tarde mandarían un taxi a quien ya se fue o quitarían una carrera a
-- otro taxista.

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('accion_diferida_max_horas', '12',
   'Cuánto atrás se le cree la hora a una acción hecha sin red. Más vieja que '
   'esto, se apunta con la hora de llegada: un reloj de móvil tan desfasado no '
   'puede reordenar la historia de un viaje');
