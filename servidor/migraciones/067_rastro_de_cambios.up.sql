-- 067 — Quién tocó los precios y los parámetros (P25-01).
--
-- El papel de agente de campo (migración 025) permite fijar las bandas de
-- precio entre zonas, y hasta ahora esos cambios no se registraban en ninguna
-- parte: no se sabía quién los hizo ni cuándo, ni qué había antes. Con dos o
-- tres agentes de confianza no era urgente; es el tipo de cosa que solo se
-- echa de menos cuando ya pasó, y entonces no hay forma de reconstruirlo.
--
-- Lo mismo vale para los parámetros del sistema, que cambian el comportamiento
-- ENTERO sin desplegar: los tiempos de las oleadas, la comisión, los umbrales
-- de alarma. Si un día el reparto se porta raro, «quién cambió qué y cuándo»
-- es la primera pregunta.
--
-- La tabla es APPEND-ONLY, con el mismo candado que `transicion` y `apunte`:
-- un registro de auditoría que se puede editar no es un registro de
-- auditoría. Se guarda el valor anterior y el nuevo, para poder deshacer sin
-- adivinar.

CREATE TABLE cambio_ajuste (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- 'banda_precio' o 'parametro'. Texto y no enum: el día que se audite otra
  -- cosa, es una fila más y no una migración de tipo.
  ambito        text NOT NULL,
  -- Qué se tocó: la clave del parámetro, o «zona origen → zona destino».
  clave         text NOT NULL,
  valor_anterior text,
  valor_nuevo   text,
  -- Quién. El dispositivo siempre; el conductor cuando quien lo hizo era un
  -- agente de campo, que es el caso que P25-01 señala. El operador no tiene
  -- fila de conductor, y por eso `es_operador` va aparte.
  dispositivo_id bigint REFERENCES dispositivo (id),
  conductor_id   bigint REFERENCES conductor (id),
  es_operador    boolean NOT NULL DEFAULT false,
  creado_en      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cambio_ajuste_por_fecha ON cambio_ajuste (creado_en DESC);

COMMENT ON TABLE cambio_ajuste IS
  'Quién cambió una banda de precio o un parámetro del sistema, cuándo, y qué '
  'había antes (migración 067). Append-only: ver el disparador.';

CREATE TRIGGER cambio_ajuste_inmutable
  BEFORE UPDATE OR DELETE ON cambio_ajuste
  FOR EACH ROW EXECUTE FUNCTION prohibir_modificacion();
