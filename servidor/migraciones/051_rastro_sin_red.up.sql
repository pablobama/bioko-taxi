-- 051 — Tres afinados de las estadísticas del taxista.
--
-- 1. EL RECORRIDO SIN COBERTURA. Hasta ahora el rastro era un efecto
--    secundario del latido: si el latido no salía —túnel, subida a Basilé,
--    barrio sin cobertura, datos agotados— ese trozo del turno no existía. Y
--    en Malabo eso no es un caso raro. Ahora el móvil apunta el recorrido por
--    su cuenta y lo sube cuando vuelve la red, así que cada punto trae SU
--    hora, no la de llegada al servidor. Dos cosas hacen falta para eso:
--    poder subir el mismo lote dos veces sin duplicar nada (el móvil reenvía
--    si no llega la confirmación), y un índice que lo garantice.
--
-- 2. LOS KILÓMETROS DE UN COCHE PARADO. Un taxi esperando en la parada del
--    mercado deja un punto de anclaje cada cinco minutos, y entre dos de esos
--    puntos hay quince o veinte metros de puro ruido del chip. Doce puntos por
--    hora, ocho horas de turno: kilómetro y medio de «recorrido» sin haberse
--    movido del sitio. Ahora un salto por debajo de `rastro_ruido_m` no cuenta
--    como distancia, y uno que implique una velocidad imposible tampoco: eso
--    no es un coche, es una fijación disparada.
--
-- 3. EL TIEMPO DE UN TURNO ABANDONADO. Desde la 049 el turno dura hasta que
--    el taxista lo cierra, y a las doce horas sin señales se da por
--    abandonado. Correcto para el reparto, pero para las estadísticas era una
--    mentira: quien cerraba el móvil a las seis de la tarde figuraba en
--    servicio hasta las seis de la mañana. Doce horas regaladas, y una media
--    de kilómetros por hora hundida sin motivo.
--
--    La transición sabe CUÁNDO se apuntó, no cuándo pasó. Casi siempre son lo
--    mismo; para un turno abandonado no, y `ocurrio_en` es esa diferencia: la
--    última señal de vida, que es cuando el turno terminó de verdad.

ALTER TABLE transicion
  ADD COLUMN ocurrio_en timestamptz;

COMMENT ON COLUMN transicion.ocurrio_en IS
  'Cuándo pasó de verdad, si no es cuando se apuntó (migración 051). NULL casi '
  'siempre. Lo usa el turno abandonado, que se cierra doce horas después de la '
  'última señal: para las estadísticas el turno acabó en la señal, no aquí.';

-- Un lote reenviado no puede duplicar puntos. Antes hay que dejar la tabla
-- limpia: el rastro viejo se escribía con la hora del servidor y dos latidos
-- en el mismo milisegundo, aunque sea improbable, no estaban prohibidos.
DELETE FROM rastro r
 USING rastro otro
 WHERE r.conductor_id = otro.conductor_id
   AND r.creado_en = otro.creado_en
   AND r.id > otro.id;

CREATE UNIQUE INDEX rastro_sin_repetidos ON rastro (conductor_id, creado_en);

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('rastro_ruido_m', '25',
   'Por debajo de esta distancia entre dos puntos no se cuentan kilómetros: '
   'es el temblor del GPS de un coche parado, no un desplazamiento'),
  ('rastro_velocidad_maxima_kmh', '180',
   'Un tramo que implique más de esto no cuenta como distancia recorrida: no '
   'hay coche que lo haga en Bioko, así que es una fijación disparada'),
  ('rastro_lote_maximo', '500',
   'Cuántos puntos acepta de una vez el envío diferido del móvil');
