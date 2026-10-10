-- 090 — Roles de operador (10/10).
--
-- Hasta hoy todos los operadores eran iguales: cualquiera autorizado podía
-- hacerlo todo —despachar, verificar taxistas, cobrar, tocar precios—. Ahora
-- cada operador lleva los PERMISOS que le dio la raíz, y cada bloque de
-- acciones exige el suyo. Un operador sin ninguno solo consulta.
--
-- Los permisos (no una jerarquía, sino bloques acumulables):
--   · despacho      — dirigir y monitorizar carreras, hablar como Central, y
--                     las incidencias y los pasajeros.
--   · taxistas      — altas y verificación de conductores y sus coches.
--   · suscripciones — recargas del monedero y la renovación de la cuota.
--   · catalogo      — sitios, precios, parámetros, numeración.
--
-- La RAÍZ (TELEFONOS_OPERADOR / UUIDS_OPERADOR, por entorno) es la
-- administradora: tiene todos los permisos y además reparte accesos. Eso vive
-- en el entorno, no aquí, por el mismo motivo de siempre —no poder quedarse
-- sin nadie que mande por un error en la base—.
--
-- Va como text[] y no como tabla aparte porque son cuatro valores por
-- operador, se leen enteros cada vez y no se consultan por separado: una tabla
-- de cruce sería ceremonia para nada a esta escala.

ALTER TABLE operador_autorizado
  ADD COLUMN roles text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN operador_autorizado.roles IS
  'Permisos del operador (migración 090): despacho, taxistas, suscripciones, '
  'catalogo. Vacío = solo consulta. La raíz del entorno los tiene todos.';
