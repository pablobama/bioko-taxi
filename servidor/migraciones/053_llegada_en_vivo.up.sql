-- 053 — El tiempo de llegada, con la velocidad real del coche.
--
-- La 052 arregló el disparate de Malabo–Luba partiendo el trayecto en tramo
-- urbano y tramo de carretera, pero las dos velocidades siguen siendo
-- constantes de tabla. Un jueves a las siete de la tarde en la avenida de la
-- Independencia no se anda a dieciocho por hora, y un domingo por la mañana se
-- anda a treinta. El coche SABE a cuánto va —lo dice su propio rastro de
-- posiciones— y ese dato estaba ahí sin usar.
--
-- Ahora la velocidad del tramo urbano sale de lo que el coche ha andado de
-- verdad en los últimos minutos. La de carretera se queda nominal a propósito:
-- si el taxi está parado en un semáforo de Malabo camino de Luba, su velocidad
-- de ese momento no dice nada de lo que va a tardar en la carretera, y usarla
-- para los cincuenta kilómetros que faltan daría «llega en cuatro horas» por
-- un semáforo.
--
-- La medida es la distancia recorrida dividida por el tiempo TRANSCURRIDO, no
-- la velocidad instantánea. La diferencia es todo: la instantánea es cero en
-- cada semáforo y el tiempo de llegada saltaría a infinito cada dos manzanas.
-- Dividiendo por el tiempo transcurrido, las paradas ya están dentro del
-- número —que es justo lo que hay que predecir—.
--
-- Y se enseña a los DOS. El taxista no veía ningún tiempo: sabía a dónde iba y
-- no cuánto le faltaba. El pasajero lo veía mientras el taxi venía a por él y
-- lo perdía justo al subirse, que es cuando empieza a importarle.

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('eta_ventana_min', '6',
   'Minutos de recorrido reciente con los que se mide a qué velocidad va el '
   'coche. Más corto y un semáforo lo desvía; más largo y no se entera de que '
   'ha salido del atasco'),
  ('eta_muestra_minima_seg', '90',
   'Sin al menos este rato medido no hay velocidad creíble: se usa la nominal'),
  ('eta_muestra_minima_m', '200',
   'Ni sin al menos estos metros. Un coche que no se ha movido no dice a qué '
   'velocidad va, dice que está parado'),
  ('eta_velocidad_minima_kmh', '8',
   'Suelo de la velocidad medida. Sin él, un taxi esperando en doble fila '
   'daría tiempos de llegada de horas'),
  ('eta_velocidad_maxima_kmh', '100',
   'Techo de la velocidad medida. Por encima es una fijación disparada del '
   'GPS, no un coche en Bioko');
