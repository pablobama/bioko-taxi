-- 054 — Cada punto del recorrido dice cuánto vale.
--
-- Revisando el camino del dato, del GPS a esta tabla, había dos cosas que el
-- teléfono SABÍA y se perdían por el camino:
--
-- 1. LA PRECISIÓN. Una lectura de GPS a cielo abierto viene con ±5 m; una de
--    antena, con ±900. El navegador lo dice, la PWA incluso lo mandaba en el
--    latido, y `registrarRastro` lo ignoraba: esta tabla no tenía dónde
--    guardarlo. Así que un punto de antena entraba en el recorrido igual que
--    uno bueno, dibujaba una línea que no existió y sumaba kilómetros. El
--    ancla y el tope de velocidad de la 051 atrapan los saltos grotescos,
--    pero no uno de trescientos metros repartido en cinco minutos: eso son
--    3,6 km/h, perfectamente creíble, y trescientos metros inventados de ida
--    y otros tantos de vuelta.
--
--    Ahora se guarda, y lo que venga peor que `rastro_precision_maxima_m` no
--    se apunta. Sin precisión conocida SÍ se apunta —hay clientes que todavía
--    no la mandan, y tirar todo lo suyo sería peor—, pero queda como NULL y se
--    ve en el informe de turno.
--
-- 2. LA HORA DE LA LECTURA. El latido esperaba hasta ocho segundos la mejor
--    fijación y luego cruzaba la red; el servidor le ponía SU hora de llegada.
--    En tramos de treinta segundos, eso es hasta un veinticinco por ciento de
--    error en la velocidad. El envío diferido de la 051 ya traía la hora
--    buena; ahora el latido también (ver la ruta del latido: se acepta dentro
--    de un margen y si no, manda el reloj del servidor).

ALTER TABLE rastro
  ADD COLUMN precision_m real;

COMMENT ON COLUMN rastro.precision_m IS
  'Radio de error de la lectura, en metros (migración 054). NULL si el cliente '
  'no lo mandó: se sabe que no se sabe, que no es lo mismo que «bueno».';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('rastro_precision_maxima_m', '50',
   'Lecturas con más error que esto no entran en el recorrido. Un GPS en la '
   'calle da 5-20 m; por encima de 50 casi siempre es antena o un rebote entre '
   'edificios, y dibuja y suma lo que no pasó'),
  ('latido_desfase_maximo_seg', '120',
   'Cuánto puede diferir la hora de la lectura que manda el móvil de la del '
   'servidor para creérsela. Fuera de eso, manda el reloj del servidor: un '
   'móvil con la hora mal puesta no puede mover el recorrido de sitio');
