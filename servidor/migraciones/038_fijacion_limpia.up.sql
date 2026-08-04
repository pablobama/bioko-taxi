-- 038 — Fijar con las mismas reglas los tres niveles, y unir cada barrio con
-- su entrada del buscador.
--
-- DOS PROBLEMAS QUE VENÍAN DE ANTES.
--
-- 1. La exigencia estaba al revés de donde más duele. Situar un barrio pedía
--    GPS de verdad y guardaba con qué precisión se tomó (migración 026);
--    dar de alta un lugar no pedía nada y no guardaba nada. Pero el lugar es
--    lo que teclea el pasajero, y su zona es de donde sale el reparto: un
--    lugar mal puesto manda la carrera al barrio equivocado, y encima no
--    quedaba constancia de con qué confianza se había puesto.
--
--    Se añade `precision_gps_m` también a la referencia, con el mismo
--    significado que en zona: metros de radio que declaró el teléfono. NULL
--    = se escribió a mano o vino del importador, o sea, sin verificar sobre
--    el terreno. Los 4.500 del catálogo quedan a NULL a propósito: son
--    plausibles, no verificados (P1-03), y fingir una precisión sería peor.
--
-- 2. Un barrio y su entrada del buscador no estaban unidos por nada. Al
--    situar un barrio se crea también una `referencia` con el mismo nombre y
--    categoría «zona», para que «llévame a Ela Nguema» funcione. Pero la
--    única relación era que coincidiera el nombre: si alguien renombra el
--    barrio, la entrada vieja se queda huérfana con el nombre antiguo y se
--    crea otra. Es la misma fragilidad que dejó hoteles y bares convertidos
--    en barrios.
--
--    `zona.referencia_id` lo dice explícitamente. El relleno usa la
--    convención que había hasta ahora —misma zona, mismo nombre, categoría
--    «zona»—, que es exactamente lo que el código creaba.

ALTER TABLE referencia
  ADD COLUMN precision_gps_m double precision;

COMMENT ON COLUMN referencia.precision_gps_m IS
  'Radio de error en metros que declaró el teléfono al fijar el sitio. NULL: '
  'se escribió a mano o vino del importador — sin verificar sobre el terreno.';

ALTER TABLE zona
  ADD COLUMN referencia_id bigint REFERENCES referencia (id);

COMMENT ON COLUMN zona.referencia_id IS
  'La entrada del buscador que representa al propio barrio (migración 038). '
  'Sin esto, renombrar un barrio dejaba la entrada vieja huérfana y creaba '
  'otra. NULL en barrios todavía sin situar: no tienen entrada.';

UPDATE zona z
SET referencia_id = r.id
FROM referencia r
WHERE r.zona_id = z.id
  AND r.nombre = z.nombre
  AND r.categoria = 'zona'
  AND z.referencia_id IS NULL;
