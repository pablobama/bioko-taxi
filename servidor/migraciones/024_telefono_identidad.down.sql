-- 024 — Revertir el teléfono como clave de identidad.
--
-- Los números normalizados se quedan como están: volver a «+240222410986» →
-- «222410986» sería inventarse cómo lo escribió cada uno, y la forma canónica
-- no rompe nada de lo anterior (la validación de la API siempre la aceptó).

DROP INDEX IF EXISTS perfil_cliente_telefono_vigente;

ALTER TABLE perfil_cliente DROP COLUMN IF EXISTS telefono_vigente;
