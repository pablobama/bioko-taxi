-- 018 — Solicitudes de recarga del monedero (decisión de sesión, 2026-07-27).
--
-- Hasta ahora meter dinero en el monedero era un apunte a mano en la base de
-- datos (P17-04). Ahora el conductor lo pide desde la app y el operador lo
-- confirma cuando ve el dinero.
--
-- ADVERTENCIA, no borrar: la plataforma NO COMPRUEBA NINGÚN PAGO.
--
-- No hay integración con Muni Dinero ni con ningún banco: nadie consulta si la
-- transferencia llegó. El flujo es:
--   1. El conductor pide recargar N XAF y elige cómo paga.
--   2. La app le da una REFERENCIA y los datos de pago.
--   3. El conductor paga por su cuenta (Muni Dinero o efectivo al operador).
--   4. Una PERSONA mira la cuenta de Muni Dinero o recibe el efectivo, y
--      confirma la recarga en el sistema con esa referencia.
--   5. Solo entonces se crea el apunte y sube el saldo.
--
-- Confirmar sin haber visto el dinero es regalar saldo. La referencia existe
-- justamente para que el operador pueda casar cada pago con su solicitud.

CREATE TABLE recarga (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conductor_id   bigint NOT NULL REFERENCES conductor (id),
  importe_xaf    integer NOT NULL CHECK (importe_xaf > 0),
  metodo         text NOT NULL CHECK (metodo IN ('muni_dinero', 'efectivo')),
  -- Código corto que el conductor pone como concepto del envío y que el
  -- operador busca para saber de quién es el dinero.
  referencia     text NOT NULL UNIQUE,
  estado         text NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'confirmada', 'rechazada', 'caducada')),
  solicitada_en  timestamptz NOT NULL DEFAULT now(),
  resuelta_en    timestamptz,
  resuelta_por   text,
  nota           text,
  -- El apunte que generó al confirmarse. NULL mientras no se confirme: es la
  -- prueba de que ninguna recarga pendiente ha tocado el saldo.
  apunte_id      bigint REFERENCES apunte (id)
);

CREATE INDEX recarga_pendientes ON recarga (solicitada_en)
  WHERE estado = 'pendiente';
CREATE INDEX recarga_por_conductor ON recarga (conductor_id, solicitada_en DESC);

COMMENT ON TABLE recarga IS
  'Solicitudes de recarga del monedero. NO verifica pagos: el operador confirma '
  'a mano tras comprobar el ingreso. Sin confirmar, el saldo no cambia.';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('muni_dinero_numero', '555926804',
   'Número de Muni Dinero al que los conductores envían las recargas'),
  ('muni_dinero_titular', 'Taxi Malabo',
   'Nombre que verá el conductor al hacer el envío, para confirmar que acierta'),
  ('recarga_minima_xaf', '1500',
   'Recarga mínima: una semana de suscripción'),
  ('recarga_caducidad_horas', '72',
   'Horas tras las que una recarga pendiente se da por caducada');
