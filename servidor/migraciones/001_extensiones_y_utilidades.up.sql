-- 001 — Extensiones y utilidades comunes

-- Búsqueda difusa del gazetteer (sección 7)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Función de trigger para tablas de solo inserción (libro contable y log de
-- transiciones). Regla dura 4.2: el estado es una proyección del log; el log
-- no se reescribe jamás.
CREATE FUNCTION prohibir_modificacion() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'La tabla "%" es de solo inserción: no se permite % sobre sus filas',
    TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
