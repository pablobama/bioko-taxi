-- 068 — Confirmar una recarga deja de ser un acto de fe (P18-01).
--
-- No hay integración con Muni Dinero ni con ningún banco, y esta migración NO
-- la inventa: el dinero sigue sin pasar por aquí, y quien dice que el pago
-- llegó sigue siendo una persona mirando una cuenta. Lo que cambia es que esa
-- afirmación deja de ser irrepetible y anónima:
--
--   1. Al confirmar hay que escribir el COMPROBANTE, que es el identificador
--      que da el propio pago (el de la transferencia de Muni Dinero, o el
--      número del recibo en efectivo). No demuestra nada por sí solo, pero
--      convierte «lo he visto» en una afirmación comprobable: cualquiera
--      puede cotejarla después contra el extracto.
--   2. El mismo comprobante NO puede confirmar dos recargas. Es el fraude
--      obvio —un pago, dos saldos— y hasta ahora nada lo impedía.
--   3. Quién confirmó ya se guardaba (`resuelta_por`); ahora se enseña junto
--      al comprobante, que es lo que lo hace útil.
--
-- Lo que sigue pendiente y no se arregla con código: si Muni Dinero publicara
-- una API o exportara movimientos, casar la referencia sería automático. Hoy
-- no. Esto es lo mejor que se puede hacer sin eso, y no pretende ser más.
--
-- Las recargas ya confirmadas se quedan sin comprobante, y se ven: `NULL` es
-- «se confirmó antes de que esto existiera», no «se perdió».

ALTER TABLE recarga ADD COLUMN comprobante text;

COMMENT ON COLUMN recarga.comprobante IS
  'Identificador del pago que el operador dice haber visto (migración 068). '
  'NULL en las confirmadas antes de existir esta columna.';

-- Un pago confirma UNA recarga. Índice único parcial: las no confirmadas no
-- tienen comprobante y no estorban.
CREATE UNIQUE INDEX recarga_comprobante_unico
  ON recarga (upper(comprobante)) WHERE comprobante IS NOT NULL;

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('recarga_exige_comprobante', '1',
   'Si a 1, no se puede confirmar una recarga sin escribir el identificador '
   'del pago (migración 068). A 0 vuelve a confirmarse a ojo');
