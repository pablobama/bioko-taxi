-- 005 — Ciclo del viaje: solicitud, oferta, viaje, transiciones, valoración,
--       incidencia y bandas de precio (secciones 4, 5 y 6)

CREATE TABLE solicitud (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispositivo_cliente_id bigint NOT NULL REFERENCES dispositivo (id),
  -- El teléfono del cliente solo se revela al conductor en ACEPTADO → EN_CAMINO
  -- (R3); esa restricción vive en la capa de API, aquí solo se almacena.
  telefono_cliente       text NOT NULL,
  referencia_origen_id   bigint NOT NULL REFERENCES referencia (id),
  referencia_destino_id  bigint NOT NULL REFERENCES referencia (id),
  estado                 text NOT NULL DEFAULT 'SOLICITADO' REFERENCES estado (nombre),
  -- Asignado por la reclamación atómica (R2):
  --   UPDATE solicitud SET estado='ACEPTADO', conductor_id=$1
  --   WHERE id=$2 AND estado='EMITIDO';
  conductor_id           bigint REFERENCES conductor (id),
  creada_en              timestamptz NOT NULL DEFAULT now(),
  expira_en              timestamptz,
  -- hash(dispositivo, origen, destino, ventana_60s): un reintento de red no
  -- puede crear una segunda solicitud (R1, regla 4.2.5).
  clave_idempotencia     text NOT NULL UNIQUE
);

CREATE INDEX solicitud_estado_creada ON solicitud (estado, creada_en);
CREATE INDEX solicitud_dispositivo ON solicitud (dispositivo_cliente_id);

CREATE TABLE oferta (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id  bigint NOT NULL REFERENCES solicitud (id),
  conductor_id  bigint NOT NULL REFERENCES conductor (id),
  oleada        smallint NOT NULL CHECK (oleada BETWEEN 1 AND 3),
  enviada_en    timestamptz NOT NULL DEFAULT now(),
  vista_en      timestamptz,
  respondida_en timestamptz,
  resultado     text CHECK (resultado IN ('aceptada', 'rechazada', 'expirada', 'perdida')),
  -- Un conductor recibe como mucho una oferta por solicitud.
  UNIQUE (solicitud_id, conductor_id)
);

CREATE INDEX oferta_conductor ON oferta (conductor_id);

CREATE TABLE viaje (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id                bigint NOT NULL UNIQUE REFERENCES solicitud (id),
  conductor_id                bigint NOT NULL REFERENCES conductor (id),
  -- Generado al aceptar, mostrado al cliente, introducido por el conductor (R5).
  pin                         text NOT NULL CHECK (pin ~ '^[0-9]{4}$'),
  -- Dinero: enteros XAF, nunca float (regla 4.2.1). Ambas partes reportan por
  -- separado; la divergencia sistemática es señal de abuso (R5).
  precio_reportado_cliente    bigint CHECK (precio_reportado_cliente >= 0),
  precio_reportado_conductor  bigint CHECK (precio_reportado_conductor >= 0),
  validado_en                 timestamptz,
  completado_en               timestamptz,
  creado_en                   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX viaje_conductor ON viaje (conductor_id);

-- Log de cambios de estado, de solo inserción (regla 4.2.3). El estado actual
-- de solicitud/presencia es una proyección de este log.
CREATE TABLE transicion (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ambito          text NOT NULL CHECK (ambito IN ('solicitud', 'conductor')),
  solicitud_id    bigint REFERENCES solicitud (id),
  conductor_id    bigint REFERENCES conductor (id),
  estado_anterior text REFERENCES estado (nombre),
  estado_nuevo    text NOT NULL REFERENCES estado (nombre),
  actor           text NOT NULL CHECK (actor IN ('cliente', 'conductor', 'sistema', 'operador')),
  origen_evento   text,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (ambito = 'solicitud' AND solicitud_id IS NOT NULL)
    OR (ambito = 'conductor' AND conductor_id IS NOT NULL)
  )
);

CREATE INDEX transicion_solicitud ON transicion (solicitud_id) WHERE solicitud_id IS NOT NULL;
CREATE INDEX transicion_conductor ON transicion (conductor_id) WHERE conductor_id IS NOT NULL;

CREATE TRIGGER transicion_solo_insercion
  BEFORE UPDATE OR DELETE ON transicion
  FOR EACH ROW EXECUTE FUNCTION prohibir_modificacion();

CREATE TABLE valoracion (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  viaje_id   bigint NOT NULL REFERENCES viaje (id),
  emisor     text NOT NULL CHECK (emisor IN ('cliente', 'conductor')),
  puntuacion smallint NOT NULL CHECK (puntuacion BETWEEN 1 AND 5),
  motivo     text,
  creada_en  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (viaje_id, emisor)
);

CREATE TABLE incidencia (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  viaje_id     bigint NOT NULL REFERENCES viaje (id),
  tipo         text NOT NULL,
  descripcion  text,
  resuelta_por text,
  resuelta_en  timestamptz,
  creada_en    timestamptz NOT NULL DEFAULT now()
);

-- Bandas orientativas de precio por par de zonas (nunca tarifa impuesta).
-- Percentiles en XAF enteros, recalculados a partir de precios reportados.
CREATE TABLE banda_precio (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  zona_origen_id  bigint NOT NULL REFERENCES zona (id),
  zona_destino_id bigint NOT NULL REFERENCES zona (id),
  p25             bigint NOT NULL CHECK (p25 >= 0),
  p50             bigint NOT NULL CHECK (p50 >= p25),
  p75             bigint NOT NULL CHECK (p75 >= p50),
  muestras        integer NOT NULL DEFAULT 0,
  actualizada_en  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (zona_origen_id, zona_destino_id)
);
