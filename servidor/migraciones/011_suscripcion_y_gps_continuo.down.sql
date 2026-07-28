-- 011 — Revertir suscripción y GPS continuo

DELETE FROM enrutamiento WHERE evento = 'D7_suscripcion';
DELETE FROM transicion_valida
  WHERE ambito = 'solicitud' AND actor = 'sistema'
    AND ((estado_origen = 'EN_CAMINO' AND estado_destino = 'RECOGIDO')
      OR (estado_origen = 'RECOGIDO' AND estado_destino = 'COMPLETADO'));
DELETE FROM parametro WHERE clave IN
  ('suscripcion_importe_xaf', 'suscripcion_dias', 'gps_umbral_recogida_m',
   'gps_umbral_separacion_m', 'gps_frescura_seg');
DROP TABLE IF EXISTS posicion;
ALTER TABLE conductor DROP COLUMN IF EXISTS suscrito_hasta;
ALTER TABLE apunte DROP CONSTRAINT IF EXISTS apunte_suscripcion_negativa;
ALTER TABLE apunte DROP CONSTRAINT IF EXISTS apunte_tipo_valido;
ALTER TABLE apunte ADD CONSTRAINT apunte_tipo_check
  CHECK (tipo IN ('recarga', 'comision', 'ajuste', 'devolucion'));
