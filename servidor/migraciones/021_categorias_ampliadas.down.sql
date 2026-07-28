-- 021 — Revertir la ampliación de categorías.
--
-- Si alguna referencia quedó con una categoría nueva, se reasigna a «otro»
-- antes de restringir el CHECK, o la migración de bajada fallaría.

UPDATE referencia SET categoria = 'otro'
  WHERE categoria IN ('hotel', 'banco', 'restaurante', 'zona');

ALTER TABLE referencia DROP CONSTRAINT referencia_categoria_check;

ALTER TABLE referencia
  ADD CONSTRAINT referencia_categoria_check CHECK (categoria IN (
    'mercado', 'iglesia', 'hospital', 'farmacia', 'escuela', 'deporte',
    'gobierno', 'transporte', 'gasolinera', 'plaza', 'otro'
  ));
