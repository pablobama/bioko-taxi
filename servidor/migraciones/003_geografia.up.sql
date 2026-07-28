-- 003 — Geografía: zonas, adyacencia y gazetteer de referencias (sección 7)

CREATE TABLE zona (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre        text NOT NULL UNIQUE,
  centroide_lat double precision,
  centroide_lng double precision,
  -- Polígono opcional en GeoJSON; el despacho funciona solo con zona y
  -- adyacencia, el polígono es informativo por ahora.
  poligono      jsonb,
  zona_padre_id bigint REFERENCES zona (id),
  creada_en     timestamptz NOT NULL DEFAULT now()
);

-- Adyacencia entre zonas para la oleada 3 (sección 8). Se almacena en ambos
-- sentidos; la carga de datos debe insertar los dos pares.
CREATE TABLE zona_adyacencia (
  zona_id           bigint NOT NULL REFERENCES zona (id),
  zona_adyacente_id bigint NOT NULL REFERENCES zona (id),
  PRIMARY KEY (zona_id, zona_adyacente_id),
  CHECK (zona_id <> zona_adyacente_id)
);

CREATE TABLE referencia (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  zona_id     bigint NOT NULL REFERENCES zona (id),
  nombre      text NOT NULL,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  -- El contador reordena resultados de búsqueda: lo más pedido sube.
  veces_usada bigint NOT NULL DEFAULT 0,
  activa      boolean NOT NULL DEFAULT true,
  creada_en   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (zona_id, nombre)
);

CREATE INDEX referencia_nombre_trgm ON referencia USING gin (nombre gin_trgm_ops);

-- Los alias («como la llama la gente») van en tabla hija en lugar de text[]
-- para poder indexarlos con trigram y buscarlos con la misma consulta difusa.
CREATE TABLE referencia_alias (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referencia_id  bigint NOT NULL REFERENCES referencia (id) ON DELETE CASCADE,
  alias          text NOT NULL,
  UNIQUE (referencia_id, alias)
);

CREATE INDEX referencia_alias_trgm ON referencia_alias USING gin (alias gin_trgm_ops);
