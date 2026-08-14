-- 047 — Una sola lectura mala de GPS no puede cerrar un viaje.
--
-- Lo que pasó hoy en producción: viajes terminándose solos sin que lo pulsara
-- ni el conductor ni el pasajero.
--
-- El cierre automático (migración 011) compara la última posición del taxista
-- con la del pasajero: si se separan 250 m estando ya RECOGIDO, se da el
-- servicio por terminado. La regla es buena —van en el mismo coche, si se
-- alejan es que se ha bajado— pero se aplicaba sobre dos coordenadas de las
-- que no se sabía NADA sobre su fiabilidad. Un teléfono dentro de un coche en
-- marcha, en una ciudad con edificios, devuelve de vez en cuando una lectura
-- con ±400 m de error que cae a media ciudad de distancia. Con eso bastaba
-- para cerrar el viaje: no hacía falta que nadie se bajara.
--
-- La misma ceguera afecta a la recogida automática, solo que al revés: dos
-- lecturas malas que casualmente coinciden marcan como recogido a alguien que
-- todavía está esperando en la acera.
--
-- Aquí se guarda la precisión de cada lectura. Con ella, `proximidad.ts` deja
-- de comparar dos puntos y pasa a comparar dos círculos: solo actúa cuando la
-- separación es real MÁS ALLÁ del error de las dos medidas. Es lo mismo que
-- ya hace el resto del sistema desde la migración 046 con el punto de
-- recogida: una coordenada sin saber su precisión no es una coordenada.
--
-- NULL es «no se sabe»: las posiciones ya guardadas, y las que manden clientes
-- viejos que aún no envían el dato. Para no romper esos viajes a mitad, NULL
-- se trata con un margen prudente configurable en vez de rechazarse.

ALTER TABLE posicion
  ADD COLUMN precision_m double precision;

COMMENT ON COLUMN posicion.precision_m IS
  'Radio de error del GPS de esta lectura, en metros (migración 047). NULL: '
  'no se sabe. Lo usa el cierre y la recogida automáticos para no decidir '
  'sobre ruido.';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('gps_precision_supuesta_m', '60',
   'Precisión que se supone a una posición que llega sin declararla. Se usa '
   'como margen en las decisiones automáticas: ni se descarta la lectura ni '
   'se le cree a ciegas'),
  ('gps_precision_maxima_decision_m', '150',
   'Por encima de este error, una posición no decide nada por sí sola: ni '
   'recoge ni cierra un viaje. Sigue viéndose en el mapa');
