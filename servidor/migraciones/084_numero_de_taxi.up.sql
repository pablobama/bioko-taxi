-- 084 — El número de taxi (06/10).
--
-- Cada taxista tiene un número corto de flota: A000, A001… hasta A999, luego
-- B000, y agotado Z999 se pasa a dos letras (AA000, AB000…). Es el número que
-- se pinta en el coche y se dicta por teléfono — «mándame el A013» se dice y
-- se oye mejor que una matrícula.
--
-- TRES REGLAS, confirmadas por el operador:
--   · Lo da la secuencia, al nacer el conductor. Sin huecos y sin elegir.
--   · A mano solo se asigna un número POR DETRÁS del último generado: sirve
--     para respetar el número que un coche ya lleva pintado, no para saltar
--     la cola.
--   · ES PARA SIEMPRE. No se cambia, no se recicla, no hay ruta que lo toque.
--     Un número que puede cambiar de coche no sirve para pintarlo en una
--     puerta.
--
-- Los conductores que ya existen reciben el suyo aquí mismo, por orden de
-- alta: el más antiguo es A000, como habría sido si la numeración hubiera
-- existido desde el primer día.

ALTER TABLE conductor ADD COLUMN numero_taxi text;

-- Único cuando existe. Sin NOT NULL: hay fixtures y caminos raros que insertan
-- conductores a pelo, y un alta que reviente por el número es peor que una
-- fila que lo reciba después. Los tres caminos reales lo asignan siempre.
CREATE UNIQUE INDEX conductor_numero_taxi
  ON conductor (numero_taxi)
  WHERE numero_taxi IS NOT NULL;

WITH ordenados AS (
  SELECT id, row_number() OVER (ORDER BY fecha_alta, id) - 1 AS idx
  FROM conductor
)
UPDATE conductor c
SET numero_taxi =
  CASE WHEN o.idx / 1000 < 26
    -- Un bloque de mil por letra: A000–A999, B000–B999…
    THEN chr(65 + (o.idx / 1000)::int)
    -- …y agotadas las 26 letras, dos: AA, AB… (base 26 sobre el resto).
    ELSE chr(65 + (((o.idx / 1000) - 26) / 26)::int)
      || chr(65 + (((o.idx / 1000) - 26) % 26)::int)
  END || lpad((o.idx % 1000)::text, 3, '0')
FROM ordenados o
WHERE o.id = c.id;

COMMENT ON COLUMN conductor.numero_taxi IS
  'Número de flota (migración 084): A000…Z999 y luego dos letras. Lo da la '
  'secuencia al nacer; a mano solo por detrás del último generado; y es para '
  'siempre — no se cambia ni se recicla.';

-- El puntero de la secuencia. En `parametro` y no en una secuencia de
-- Postgres a propósito: al asignar se lee con FOR UPDATE dentro de la misma
-- transacción del alta, así que dos altas a la vez no pueden llevarse el
-- mismo número, y un alta que falla no quema un número (la secuencia nativa
-- sí lo quemaría).
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('numero_taxi_siguiente', (SELECT count(*)::text FROM conductor),
   'Índice del próximo número de taxi (migración 084): 0 es A000, 1000 es '
   'B000. NO tocarlo a mano: bajarlo haría que la secuencia repartiera '
   'números que ya son de alguien.');
