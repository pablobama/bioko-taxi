-- 017 — Revertir la categoría de las referencias

ALTER TABLE referencia DROP COLUMN IF EXISTS categoria;
