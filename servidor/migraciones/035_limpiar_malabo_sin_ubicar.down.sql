-- 035 — No se puede revertir.
--
-- El borrado de barrios no tiene vuelta atrás: la migración no guarda lo
-- que quitó. Es lo pedido a propósito —el operador los va a volver a dar
-- de alta sobre el terreno, con el GPS y ya dentro de su distrito urbano—,
-- pero conviene que quede dicho aquí y no que un `revertir` finja que
-- deshace algo.

DO $$
BEGIN
  RAISE EXCEPTION 'La migración 035 borró barrios y no se puede revertir. Vuelve a darlos de alta desde el panel.';
END $$;
