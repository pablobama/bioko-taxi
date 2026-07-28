-- 017 — Categoría de las referencias del gazetteer (decisión de sesión).
--
-- Para que el mapa del cliente pueda dibujar un icono reconocible en cada sitio
-- (mercado, iglesia, hospital…) en lugar de un punto anónimo. Es dato del
-- catálogo, no cosa de la interfaz: la mantiene el operador con el resto del
-- gazetteer.

ALTER TABLE referencia
  ADD COLUMN categoria text NOT NULL DEFAULT 'otro'
    CHECK (categoria IN (
      'mercado', 'iglesia', 'hospital', 'farmacia', 'escuela', 'deporte',
      'gobierno', 'transporte', 'gasolinera', 'plaza', 'otro'
    ));

COMMENT ON COLUMN referencia.categoria IS
  'Tipo de sitio, solo para elegir el icono en el mapa. «otro» es un punto sin icono.';

-- Las 22 referencias reales de Malabo que trae la semilla. Se hace aquí y no
-- solo en el script de semilla para que las bases ya cargadas se actualicen.
UPDATE referencia SET categoria = 'mercado'    WHERE nombre LIKE 'Mercado%';
UPDATE referencia SET categoria = 'iglesia'    WHERE nombre LIKE 'Iglesia%' OR nombre LIKE 'Catedral%';
UPDATE referencia SET categoria = 'hospital'   WHERE nombre LIKE 'Hospital%';
UPDATE referencia SET categoria = 'farmacia'   WHERE nombre LIKE 'Farmacia%';
UPDATE referencia SET categoria = 'escuela'    WHERE nombre LIKE 'Colegio%' OR nombre LIKE 'Escuela%' OR nombre LIKE 'Instituto%';
UPDATE referencia SET categoria = 'deporte'    WHERE nombre LIKE 'Estadio%' OR nombre LIKE 'Campo de f%';
UPDATE referencia SET categoria = 'gobierno'   WHERE nombre LIKE 'Ayuntamiento%';
UPDATE referencia SET categoria = 'transporte' WHERE nombre LIKE 'Puerto%';
UPDATE referencia SET categoria = 'gasolinera' WHERE nombre LIKE 'Gasolinera%';
UPDATE referencia SET categoria = 'plaza'      WHERE nombre LIKE 'Plaza%' OR nombre LIKE 'Rotonda%' OR nombre LIKE 'Paseo%';
