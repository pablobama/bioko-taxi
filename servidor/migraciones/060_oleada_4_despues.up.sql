-- 060 — La oleada 4 llega DESPUÉS de la de los barrios vecinos, no a la vez.
--
-- La migración 048 prometía que un taxista «de toda la isla» no le quita nunca
-- la carrera a quien está al lado del pasajero, porque su oleada va la última.
-- Pero la oleada 3 (barrios vecinos) salía a los 45 s y la 4 también a los 45:
-- en el mismo tique del planificador, el taxista del barrio de al lado y el de
-- la oficina recibían la oferta a la vez, y ganaba quien pulsara antes.
--
-- A los 60 s: quince segundos de turno para los vecinos, y todavía treinta
-- antes de que la solicitud caduque a los 90. Solo se toca si nadie lo había
-- cambiado a mano: es un parámetro en caliente y el operador puede tenerlo
-- ajustado.
UPDATE parametro SET valor = '60'
WHERE clave = 'oleada_4_seg' AND valor = '45';
