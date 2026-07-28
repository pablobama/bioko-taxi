-- 013 — Revertir taxis compartidos

DELETE FROM parametro WHERE clave = 'reloj_espera_con_pasajeros_seg';

UPDATE transicion_valida SET disparador = 'Gana la reclamación atómica'
WHERE ambito = 'conductor' AND estado_origen = 'OFERTADO'
  AND estado_destino = 'OCUPADO' AND actor = 'conductor';

UPDATE transicion_valida SET disparador = 'Rechaza la oferta'
WHERE ambito = 'conductor' AND estado_origen = 'OFERTADO'
  AND estado_destino = 'DISPONIBLE' AND actor = 'conductor';

UPDATE transicion_valida SET disparador = 'Viaje cerrado'
WHERE ambito = 'conductor' AND estado_origen = 'OCUPADO'
  AND estado_destino = 'DISPONIBLE' AND actor = 'conductor';

UPDATE transicion_valida SET disparador = 'Viaje cancelado o reasignado'
WHERE ambito = 'conductor' AND estado_origen = 'OCUPADO'
  AND estado_destino = 'DISPONIBLE' AND actor = 'sistema';

UPDATE estado SET descripcion = 'Con un viaje en curso'
WHERE nombre = 'OCUPADO' AND ambito = 'conductor';

ALTER TABLE vehiculo DROP COLUMN IF EXISTS plazas;
