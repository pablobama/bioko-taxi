-- 004 — Actores: conductor, vehículo, dispositivo y presencia (sección 4.1)

CREATE TABLE conductor (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- El teléfono es el identificador natural del conductor.
  telefono            text NOT NULL UNIQUE,
  nombre              text NOT NULL,
  estado_verificacion text NOT NULL DEFAULT 'pendiente'
                        CHECK (estado_verificacion IN ('pendiente', 'verificado', 'suspendido', 'bloqueado')),
  fecha_alta          timestamptz NOT NULL DEFAULT now(),
  -- Caché de la prioridad calculada en el paso 10 sobre viajes validados,
  -- tasa de cancelación y señales de presencia falsa. No es fuente de verdad.
  prioridad_despacho  double precision NOT NULL DEFAULT 0
);

CREATE TABLE vehiculo (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conductor_id bigint NOT NULL REFERENCES conductor (id),
  -- La matrícula es el mecanismo de identificación del coche por el cliente
  -- en el protocolo de encuentro (R4): obligatoria.
  matricula    text NOT NULL UNIQUE,
  marca        text,
  color        text,
  foto_url     text,
  creado_en    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dispositivo (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- La identidad del cliente es el dispositivo, no el teléfono (regla 4.2.4).
  uuid_persistente  uuid NOT NULL UNIQUE,
  tipo              text NOT NULL CHECK (tipo IN ('cliente', 'conductor')),
  -- Solo los dispositivos de conductor pertenecen a un conductor registrado.
  conductor_id      bigint REFERENCES conductor (id),
  -- Solo los dispositivos de conductor tienen token FCM; la PWA del cliente
  -- no usa push (decisión 3.2).
  fcm_token         text,
  ultimo_heartbeat  timestamptz,
  strikes           integer NOT NULL DEFAULT 0 CHECK (strikes >= 0),
  bloqueado_en      timestamptz,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  CHECK ((tipo = 'conductor') = (conductor_id IS NOT NULL)),
  CHECK (tipo = 'conductor' OR fcm_token IS NULL)
);

CREATE INDEX dispositivo_conductor ON dispositivo (conductor_id) WHERE conductor_id IS NOT NULL;

-- Presencia del conductor: una fila por conductor, estado actual y último
-- heartbeat. DISPONIBLE solo cuenta con heartbeat en la ventana de 120 s
-- (decisión 3.4); esa condición la aplica la consulta de despacho, no un campo.
CREATE TABLE presencia (
  conductor_id     bigint PRIMARY KEY REFERENCES conductor (id),
  zona_id          bigint REFERENCES zona (id),
  estado           text NOT NULL DEFAULT 'DESCONECTADO' REFERENCES estado (nombre),
  ultimo_heartbeat timestamptz,
  actualizada_en   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX presencia_zona_estado ON presencia (zona_id, estado);
