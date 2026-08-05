-- 041 — Cuál es la zona que hace de cabecera de cada distrito urbano.
--
-- `distrito_urbano` (migraciones 033 y 040) es una etiqueta de texto: dice a
-- qué distrito pertenece un barrio, pero no dice cuál de esos barrios ES el
-- distrito. Y hay sitios donde eso hace falta de verdad —el desplegable que
-- elige bajo qué distrito urbano se crea un barrio o una calle— que a falta
-- del dato ofrecían la lista entera de zonas: Abayak, Comandachina o Bar
-- Peaje presentados como si fueran distritos urbanos.
--
-- No se puede deducir del nombre: la cabecera de «Sácriba» es la zona
-- «Sacriba», que entró sin tilde por el importador, y la de «Alegre» es
-- «Alegría», que es como la rotula el dato abierto. Compararlas por texto
-- funcionaría hoy y se rompería el día que alguien corrija una tilde.
--
-- Siete distritos urbanos, siete cabeceras, ni una más: lo garantiza el
-- índice único de abajo, y la comprobación final aborta la migración si
-- alguno se quedara sin la suya.

ALTER TABLE zona
  ADD COLUMN es_cabecera_urbana boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN zona.es_cabecera_urbana IS
  'La zona que hace de cabecera de su distrito urbano (migración 041). Una '
  'por distrito urbano. Es lo que se ofrece al colgar un barrio o una calle '
  'de un distrito.';

UPDATE zona SET es_cabecera_urbana = true
WHERE zona_padre_id IS NULL
  AND distrito_urbano IS NOT NULL
  AND nombre IN (
    'Malabo Centro', 'Ela Nguema', 'Semu', 'Banapá', 'Santa María',
    'Sacriba', 'Sácriba', 'Alegría', 'Alegre'
  );

-- Una cabecera es, por definición, una zona de primer nivel con distrito
-- urbano conocido.
ALTER TABLE zona ADD CONSTRAINT zona_cabecera_coherente CHECK (
  NOT es_cabecera_urbana OR (zona_padre_id IS NULL AND distrito_urbano IS NOT NULL)
);

CREATE UNIQUE INDEX zona_una_cabecera_por_distrito
  ON zona (distrito_urbano) WHERE es_cabecera_urbana;

DO $$
DECLARE
  huerfanos text;
BEGIN
  SELECT string_agg(d, ', ' ORDER BY d) INTO huerfanos
  FROM unnest(ARRAY[
    'Malabo Centro', 'Ela Nguema', 'Semu', 'Banapá', 'Santa María',
    'Sácriba', 'Alegre'
  ]) AS d
  WHERE NOT EXISTS (
    SELECT 1 FROM zona
    WHERE es_cabecera_urbana AND distrito_urbano = d
  );

  IF huerfanos IS NOT NULL THEN
    RAISE EXCEPTION
      'Distritos urbanos sin cabecera: %. Sin ella no se puede colgar nada de ellos.',
      huerfanos;
  END IF;
END $$;
