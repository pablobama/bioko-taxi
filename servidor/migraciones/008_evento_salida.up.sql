-- 008 — Buzón de salida de eventos (paso 6, patrón outbox).
--
-- El dominio escribe el evento EN LA MISMA transacción que lo causa: si la
-- transacción se deshace, el evento desaparece con ella (P5-01). El
-- despachador lo entrega después del commit consultando la tabla
-- enrutamiento, y deja aquí el rastro de la entrega.

CREATE TABLE evento_salida (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo                   text NOT NULL,
  rol                    text NOT NULL CHECK (rol IN ('cliente', 'conductor')),
  solicitud_id           bigint REFERENCES solicitud (id),
  conductor_id           bigint REFERENCES conductor (id),
  dispositivo_cliente_id bigint REFERENCES dispositivo (id),
  datos                  jsonb NOT NULL DEFAULT '{}',
  creado_en              timestamptz NOT NULL DEFAULT now(),
  intentos               integer NOT NULL DEFAULT 0,
  ultimo_error           text,
  entregado_en           timestamptz,
  -- Canal por el que salió de verdad, o marcas especiales:
  -- «suprimido» (regla con canal_1 NULL, caso C1) y «abandonado» (agotados
  -- los reintentos; el error queda en ultimo_error).
  canal_entregado        text
);

CREATE INDEX evento_salida_pendiente ON evento_salida (id) WHERE entregado_en IS NULL;

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('eventos_max_intentos', '10', 'Reintentos de entrega de un evento antes de marcarlo abandonado (paso 6)');
