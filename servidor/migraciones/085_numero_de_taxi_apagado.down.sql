-- Los números borrados por el up no se pueden resucitar; se vuelve a repartir
-- por orden de alta, que es exactamente lo que hizo la 084.
DELETE FROM parametro WHERE clave = 'numero_taxi_activado';
WITH ordenados AS (
  SELECT id, row_number() OVER (ORDER BY fecha_alta, id) - 1 AS idx
  FROM conductor
)
UPDATE conductor c
SET numero_taxi =
  CASE WHEN o.idx / 1000 < 26
    THEN chr(65 + (o.idx / 1000)::int)
    ELSE chr(65 + (((o.idx / 1000) - 26) / 26)::int)
      || chr(65 + (((o.idx / 1000) - 26) % 26)::int)
  END || lpad((o.idx % 1000)::text, 3, '0')
FROM ordenados o
WHERE o.id = c.id;
UPDATE parametro
SET valor = (SELECT count(*)::text FROM conductor)
WHERE clave = 'numero_taxi_siguiente';
