-- 021 — Amplía las categorías del gazetteer (decisión de sesión).
--
-- El catálogo real de Malabo trae hoteles, bancos, restaurantes y zonas/
-- barrios con nombre propio, que la migración 017 no contemplaba. Se añaden
-- sin tocar los valores existentes.

ALTER TABLE referencia DROP CONSTRAINT referencia_categoria_check;

ALTER TABLE referencia
  ADD CONSTRAINT referencia_categoria_check CHECK (categoria IN (
    'mercado', 'iglesia', 'hospital', 'farmacia', 'escuela', 'deporte',
    'gobierno', 'transporte', 'gasolinera', 'plaza', 'otro',
    'hotel', 'banco', 'restaurante', 'zona'
  ));
