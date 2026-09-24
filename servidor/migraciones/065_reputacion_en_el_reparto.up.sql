-- 065 — La reputación influye en el reparto (P14-04).
--
-- Hasta ahora la nota del taxista se le enseñaba al pasajero y no servía para
-- nada más: quien acumulaba malas notas recibía exactamente las mismas
-- carreras que quien las tenía buenas. La única consecuencia posible era que
-- el operador le retirara el papel a mano, que es todo o nada.
--
-- Ahora entra en el ORDEN de los candidatos, y entra con tres cuidados:
--
--   1. POR TRAMOS, no por decimales. 4,6 y 4,7 son el mismo taxista; lo que
--      de verdad distingue es «bien», «normal» y «mal». Sin tramos, una
--      décima de diferencia decidiría quién come.
--   2. NADIE JUZGADO POR TRES OPINIONES. Por debajo de
--      `reputacion_muestras_minimas` valoraciones la nota no cuenta y el
--      taxista va en el tramo del medio. Tres pasajeros de mal día no pueden
--      dejar sin trabajo a nadie, y un taxista nuevo no arranca castigado.
--   3. DESPUÉS de la prioridad del operador, que es una decisión tomada a
--      mano y con nombre, y después de «va ya hacia allí», que es lo que le
--      conviene al pasajero de esta carrera concreta.
--
-- Lo que NO hace: no excluye a nadie. Un taxista con malas notas sigue
-- recibiendo carreras —más tarde, detrás de los demás— porque dejar a alguien
-- sin trabajo por una media es una sanción, y las sanciones las pone el
-- operador con un nombre detrás.

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('reputacion_muestras_minimas', '5',
   'Valoraciones que hacen falta para que la nota del taxista cuente en el '
   'reparto. Por debajo va en el tramo del medio (migración 065)'),
  ('reputacion_tramo_bueno', '45',
   'Nota × 10 desde la que el taxista va primero en el reparto (45 = 4,5)'),
  ('reputacion_tramo_malo', '35',
   'Nota × 10 por debajo de la cual el taxista va último (35 = 3,5)');
