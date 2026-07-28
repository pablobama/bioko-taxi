-- 006 — Monedero prepago del conductor (regla 4.2.2 y R5)

CREATE TABLE monedero (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conductor_id bigint NOT NULL UNIQUE REFERENCES conductor (id),
  creado_en    timestamptz NOT NULL DEFAULT now()
  -- Deliberadamente NO hay columna saldo: el saldo es SUM(apunte.importe_xaf).
);

CREATE TABLE apunte (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  monedero_id        bigint NOT NULL REFERENCES monedero (id),
  tipo               text NOT NULL CHECK (tipo IN ('recarga', 'comision', 'ajuste', 'devolucion')),
  -- Entero XAF con signo: positivo abona, negativo carga. Nunca cero.
  importe_xaf        bigint NOT NULL CHECK (importe_xaf <> 0),
  viaje_id           bigint REFERENCES viaje (id),
  creado_en          timestamptz NOT NULL DEFAULT now(),
  -- Un reintento de red nunca genera un segundo apunte (regla 4.2.5).
  clave_idempotencia text NOT NULL UNIQUE,
  -- El signo va implícito en el tipo; un «ajuste» puede ir en ambos sentidos.
  CHECK (tipo <> 'recarga' OR importe_xaf > 0),
  CHECK (tipo <> 'comision' OR importe_xaf < 0),
  CHECK (tipo <> 'devolucion' OR importe_xaf > 0),
  -- Comisiones y devoluciones siempre trazan a un viaje concreto.
  CHECK (tipo NOT IN ('comision', 'devolucion') OR viaje_id IS NOT NULL)
);

CREATE INDEX apunte_monedero ON apunte (monedero_id);
CREATE INDEX apunte_viaje ON apunte (viaje_id) WHERE viaje_id IS NOT NULL;

CREATE TRIGGER apunte_solo_insercion
  BEFORE UPDATE OR DELETE ON apunte
  FOR EACH ROW EXECUTE FUNCTION prohibir_modificacion();

-- Fuente de verdad del saldo: el libro de apuntes. Si el rendimiento lo exige
-- se materializará, pero la definición canónica es esta.
CREATE VIEW saldo_monedero AS
  SELECT
    m.id           AS monedero_id,
    m.conductor_id AS conductor_id,
    COALESCE(SUM(a.importe_xaf), 0)::bigint AS saldo_xaf
  FROM monedero m
  LEFT JOIN apunte a ON a.monedero_id = m.id
  GROUP BY m.id, m.conductor_id;
