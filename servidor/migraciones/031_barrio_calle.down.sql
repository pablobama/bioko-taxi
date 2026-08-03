-- 031 — Revertir el comentario de zona_padre_id (la columna en sí es de la
-- migración 003 y no se toca aquí).

COMMENT ON COLUMN zona.zona_padre_id IS NULL;
