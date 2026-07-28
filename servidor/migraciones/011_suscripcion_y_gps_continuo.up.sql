-- 011 — Cambio de modelo (decisión de sesión, 2026-07-26):
--
-- 1. SUSCRIPCIÓN en lugar de comisión por viaje: el conductor paga una cuota
--    periódica (semanal, 1.500 XAF) descontada de su monedero prepago. Sin
--    suscripción vigente no recibe broadcasts. La comisión por viaje queda
--    desactivada en el flujo (los apuntes tipo «comision» se conservan como
--    primitiva contable por si vuelve un modelo híbrido).
-- 2. GPS CONTINUO durante el viaje (conductor por su app, cliente por la PWA
--    mientras la pantalla está encendida): detecta la recogida por
--    proximidad y el cierre por separación. La confirmación manual sigue
--    existiendo como respaldo: el GPS del cliente puede apagarse en
--    cualquier momento.

-- Suscripción: nuevo tipo de apunte y vencimiento en el conductor.
ALTER TABLE apunte DROP CONSTRAINT apunte_tipo_check;
ALTER TABLE apunte ADD CONSTRAINT apunte_tipo_valido
  CHECK (tipo IN ('recarga', 'comision', 'ajuste', 'devolucion', 'suscripcion'));
ALTER TABLE apunte ADD CONSTRAINT apunte_suscripcion_negativa
  CHECK (tipo <> 'suscripcion' OR importe_xaf < 0);

ALTER TABLE conductor ADD COLUMN suscrito_hasta timestamptz;

-- Traza de posiciones durante el viaje. Solo mientras hay viaje activo:
-- fuera de viaje NO se registra la posición de nadie.
CREATE TABLE posicion (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  viaje_id  bigint NOT NULL REFERENCES viaje (id),
  actor     text NOT NULL CHECK (actor IN ('cliente', 'conductor')),
  lat       double precision NOT NULL,
  lng       double precision NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX posicion_viaje_actor ON posicion (viaje_id, actor, creado_en DESC);

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('suscripcion_importe_xaf',   '1500', 'Cuota de suscripción del conductor'),
  ('suscripcion_dias',          '7',    'Días que cubre cada cuota'),
  ('gps_umbral_recogida_m',     '75',   'Distancia conductor-cliente que marca la recogida automática'),
  ('gps_umbral_separacion_m',   '250',  'Distancia que marca el fin del servicio tras la recogida'),
  ('gps_frescura_seg',          '90',   'Antigüedad máxima de una posición para contar en la detección');

-- La detección automática introduce dos transiciones del sistema.
INSERT INTO transicion_valida (ambito, estado_origen, estado_destino, actor, disparador) VALUES
  ('solicitud', 'EN_CAMINO', 'RECOGIDO',   'sistema', 'Proximidad GPS: taxi y cliente coinciden (recogida automática)'),
  ('solicitud', 'RECOGIDO',  'COMPLETADO', 'sistema', 'Separación GPS: taxi y cliente se alejan tras la recogida');

-- Avisos de suscripción al conductor.
INSERT INTO enrutamiento (evento, rol, canal_1, ttl_seg) VALUES
  ('D7_suscripcion', 'conductor', 'fcm', 86400);
