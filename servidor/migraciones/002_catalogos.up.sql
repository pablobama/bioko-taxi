-- 002 — Catálogos: estados, transiciones válidas, parámetros y enrutamiento

-- ---------------------------------------------------------------------------
-- Estados de solicitud/viaje y de conductor (sección 5.1)
-- ---------------------------------------------------------------------------
CREATE TABLE estado (
  nombre       text PRIMARY KEY,
  ambito       text NOT NULL CHECK (ambito IN ('solicitud', 'conductor')),
  es_terminal  boolean NOT NULL DEFAULT false,
  descripcion  text NOT NULL
);

INSERT INTO estado (nombre, ambito, es_terminal, descripcion) VALUES
  ('SOLICITADO',           'solicitud', false, 'El cliente confirmó origen y destino'),
  ('EMITIDO',              'solicitud', false, 'Emitida al menos una oleada a conductores conectados'),
  ('ACEPTADO',             'solicitud', false, 'Un conductor ganó la reclamación atómica'),
  ('EN_CAMINO',            'solicitud', false, 'El conductor confirmó la salida'),
  ('RECOGIDO',             'solicitud', false, 'PIN validado: el pasajero está en el vehículo'),
  ('COMPLETADO',           'solicitud', true,  'Viaje cerrado con precio reportado'),
  ('SIN_OFERTA',           'solicitud', true,  'Ningún conductor disponible o ninguno respondió'),
  ('CANCELADO_CLIENTE',    'solicitud', true,  'El cliente canceló'),
  ('CANCELADO_CONDUCTOR',  'solicitud', true,  'El conductor se echó atrás tras aceptar'),
  ('NO_PRESENTADO',        'solicitud', true,  'El conductor no llegó al punto de recogida'),
  ('CLIENTE_AUSENTE',      'solicitud', true,  'El cliente no apareció; reloj de espera agotado'),
  ('INCIDENCIA',           'solicitud', true,  'Disputa declarada durante el viaje'),
  ('DESCONECTADO',         'conductor', false, 'Sin heartbeat vivo; fuera de servicio'),
  ('DISPONIBLE',           'conductor', false, 'Heartbeat vivo en los últimos 120 s; recibe broadcasts'),
  ('OFERTADO',             'conductor', false, 'Tiene una oferta pendiente de respuesta'),
  ('OCUPADO',              'conductor', false, 'Con un viaje en curso');

-- ---------------------------------------------------------------------------
-- Transiciones válidas (sección 5.2). El servicio de transiciones (paso 2)
-- consulta esta tabla; cualquier transición ausente se rechaza con error
-- explícito. estado_origen NULL representa la creación de la entidad.
-- ---------------------------------------------------------------------------
CREATE TABLE transicion_valida (
  ambito         text NOT NULL CHECK (ambito IN ('solicitud', 'conductor')),
  estado_origen  text REFERENCES estado (nombre),
  estado_destino text NOT NULL REFERENCES estado (nombre),
  actor          text NOT NULL CHECK (actor IN ('cliente', 'conductor', 'sistema', 'operador')),
  disparador     text NOT NULL,
  UNIQUE NULLS NOT DISTINCT (ambito, estado_origen, estado_destino, actor)
);

INSERT INTO transicion_valida (ambito, estado_origen, estado_destino, actor, disparador) VALUES
  -- Ciclo de vida de la solicitud/viaje
  ('solicitud', NULL,         'SOLICITADO',          'cliente',   'Cliente confirma origen y destino'),
  ('solicitud', NULL,         'SOLICITADO',          'operador',  'Operador registra solicitud recibida por llamada de voz (3.6)'),
  ('solicitud', 'SOLICITADO', 'EMITIDO',             'sistema',   'Primera oleada enviada'),
  -- Añadida por R1 (no está en 5.2, señalada para confirmación): zona vacía →
  -- respuesta SIN_OFERTA en <5 s, sin pasar por EMITIDO porque no hubo oleada.
  ('solicitud', 'SOLICITADO', 'SIN_OFERTA',          'sistema',   'Ningún conductor con heartbeat vivo en la zona ni adyacentes (R1)'),
  ('solicitud', 'EMITIDO',    'ACEPTADO',            'conductor', 'Reclamación atómica ganada'),
  ('solicitud', 'EMITIDO',    'SIN_OFERTA',          'sistema',   'Agotadas las oleadas sin respuesta'),
  ('solicitud', 'EMITIDO',    'CANCELADO_CLIENTE',   'cliente',   'Cliente cancela durante la emisión'),
  ('solicitud', 'ACEPTADO',   'EN_CAMINO',           'conductor', 'Conductor confirma salida'),
  ('solicitud', 'ACEPTADO',   'CANCELADO_CONDUCTOR', 'conductor', 'Conductor se echa atrás'),
  ('solicitud', 'ACEPTADO',   'CANCELADO_CLIENTE',   'cliente',   'Cliente cancela dentro de la gracia de 60 s'),
  -- Añadida por R3 (no está en 5.2, señalada para confirmación): sin
  -- confirmación de salida en 90 s se reasigna automáticamente.
  ('solicitud', 'ACEPTADO',   'EMITIDO',             'sistema',   'Reasignación automática: el conductor no confirmó salida en 90 s (R3)'),
  ('solicitud', 'EN_CAMINO',  'RECOGIDO',            'conductor', 'PIN validado'),
  ('solicitud', 'EN_CAMINO',  'NO_PRESENTADO',       'sistema',   'El conductor no llega al punto de recogida'),
  ('solicitud', 'EN_CAMINO',  'NO_PRESENTADO',       'conductor', 'El conductor declara que no puede llegar'),
  ('solicitud', 'EN_CAMINO',  'CLIENTE_AUSENTE',     'conductor', 'Reloj de espera de 5 minutos agotado'),
  ('solicitud', 'RECOGIDO',   'COMPLETADO',          'conductor', 'Cierre con precio reportado'),
  ('solicitud', 'RECOGIDO',   'INCIDENCIA',          'cliente',   'Disputa declarada por el cliente'),
  ('solicitud', 'RECOGIDO',   'INCIDENCIA',          'conductor', 'Disputa declarada por el conductor'),
  ('solicitud', 'RECOGIDO',   'INCIDENCIA',          'operador',  'Disputa declarada por el operador'),
  -- Ciclo de vida del conductor (presencia)
  ('conductor', NULL,           'DESCONECTADO', 'sistema',   'Alta del conductor'),
  ('conductor', 'DESCONECTADO', 'DISPONIBLE',   'conductor', 'Entra en servicio (foreground service activo)'),
  ('conductor', 'DISPONIBLE',   'DESCONECTADO', 'conductor', 'Sale de servicio voluntariamente'),
  ('conductor', 'DISPONIBLE',   'DESCONECTADO', 'sistema',   'Heartbeat vencido (>120 s)'),
  ('conductor', 'DISPONIBLE',   'OFERTADO',     'sistema',   'Incluido en una oleada'),
  ('conductor', 'OFERTADO',     'DISPONIBLE',   'conductor', 'Rechaza la oferta'),
  ('conductor', 'OFERTADO',     'DISPONIBLE',   'sistema',   'Oferta expirada o reclamación perdida'),
  ('conductor', 'OFERTADO',     'OCUPADO',      'conductor', 'Gana la reclamación atómica'),
  ('conductor', 'OCUPADO',      'DISPONIBLE',   'conductor', 'Viaje cerrado'),
  ('conductor', 'OCUPADO',      'DISPONIBLE',   'sistema',   'Viaje cancelado o reasignado');

-- ---------------------------------------------------------------------------
-- Parámetros operativos (sección 10: nada de constantes de negocio en código)
-- ---------------------------------------------------------------------------
CREATE TABLE parametro (
  clave          text PRIMARY KEY,
  valor          text NOT NULL,
  descripcion    text NOT NULL,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('comision_por_viaje_xaf',          '100',  'Comisión fija descontada al conductor por viaje validado (sección 10)'),
  ('ventana_heartbeat_seg',           '120',  'Un conductor está DISPONIBLE solo con heartbeat en esta ventana (3.4)'),
  ('gracia_cancelacion_cliente_seg',  '60',   'Cancelación del cliente sin strike tras la aceptación (R3)'),
  ('plazo_confirmar_salida_seg',      '90',   'Sin confirmación de salida en este plazo: reasignación y penalización (R3)'),
  ('reloj_espera_cliente_seg',        '300',  'Reloj visible para ambos tras «he llegado»; agotado, el conductor puede declarar ausencia (R4)'),
  ('strikes_para_bloqueo',            '3',    'Strikes de dispositivo que provocan bloqueo (R4)'),
  ('oleada_2_seg',                    '20',   'Segundos hasta la oleada 2 (sección 8)'),
  ('oleada_3_seg',                    '45',   'Segundos hasta la oleada 3, zonas adyacentes (sección 8)'),
  ('expiracion_solicitud_seg',        '90',   'Segundos hasta SIN_OFERTA si nadie acepta (sección 8)'),
  ('oleada_1_max_conductores',        '3',    'Conductores de la oleada 1 (sección 8)'),
  ('oleada_2_max_conductores',        '8',    'Conductores acumulados en la oleada 2 (sección 8)'),
  ('corte_zona_vacia_seg',            '5',    'Plazo máximo para responder SIN_OFERTA si no hay conductores (R1)'),
  ('alarma_tasa_validacion_min',      '0.80', 'Por debajo: el modelo de ingresos se desangra (R5, sección 11)'),
  ('alarma_tasa_sin_oferta_max',      '0.30', 'Por zona y franja (sección 11)'),
  ('alarma_tasa_no_presentado_max',   '0.10', 'Por conductor (sección 11)'),
  ('alarma_tasa_acept_cancel_max',    '0.15', 'Por conductor; por encima se reduce prioridad_despacho (R2)'),
  ('alarma_coste_mensajeria_xaf',     '25',   'Coste de mensajería por viaje completado (sección 11)');

-- ---------------------------------------------------------------------------
-- Enrutamiento de notificaciones (sección 9): datos, no código.
-- canal_1 NULL significa evento suprimido deliberadamente (caso C1).
-- ---------------------------------------------------------------------------
CREATE TABLE enrutamiento (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evento             text NOT NULL,
  rol                text NOT NULL CHECK (rol IN ('cliente', 'conductor')),
  canal_1            text,
  canal_2            text,
  condicion_escalada text,
  ttl_seg            integer,
  coste_max_xaf      bigint NOT NULL DEFAULT 0,
  activo             boolean NOT NULL DEFAULT true,
  UNIQUE (evento, rol)
);

INSERT INTO enrutamiento (evento, rol, canal_1, canal_2, condicion_escalada, ttl_seg) VALUES
  ('D1_broadcast_solicitud',    'conductor', 'fcm',                NULL,               NULL,         20),
  ('D2_reclamacion_resuelta',   'conductor', 'fcm',                NULL,               NULL,         30),
  ('D3_viaje_cerrado_comision', 'conductor', 'fcm',                NULL,               NULL,         3600),
  ('D4_saldo_bajo',             'conductor', 'fcm',                NULL,               NULL,         86400),
  ('D5_recarga_confirmada',     'conductor', 'fcm',                NULL,               NULL,         3600),
  ('D6_aviso_calidad',          'conductor', 'fcm',                'llamada_operador', 'suspension', 86400),
  ('C1_acuse_recibo',           'cliente',   NULL,                 NULL,               NULL,         NULL),
  ('C2_conductor_asignado',     'cliente',   'sse',                NULL,               NULL,         90),
  ('C3_sin_conductor',          'cliente',   'sse',                NULL,               NULL,         90),
  ('C4_conductor_cancelo',      'cliente',   'sse',                NULL,               NULL,         90),
  ('C5_taxi_ha_llegado',        'cliente',   'llamada_conductor',  NULL,               NULL,         NULL),
  ('C6_valoracion',             'cliente',   'diferido_proxima_sesion', NULL,          NULL,         NULL);
