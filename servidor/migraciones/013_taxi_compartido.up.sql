-- 013 — Taxis compartidos (decisión de sesión, 2026-07-26).
--
-- En Guinea Ecuatorial el taxi es compartido: el conductor va llenando el
-- coche con gente que va en la misma dirección y cada uno paga su parte. Esto
-- revierte el no-objetivo «no hay viajes compartidos» de la sección 14 de la
-- especificación, por decisión explícita: es el mercado real.
--
-- Cambio central: OCUPADO deja de significar «tiene un viaje» y pasa a
-- significar «coche lleno». Un conductor con pasajeros dentro y plazas libres
-- sigue siendo DISPONIBLE y sigue recibiendo ofertas.
--
-- Cada pasajero conserva su propia solicitud y su propio viaje: no hay tabla
-- nueva. Lo que cambia es cuántos viajes puede tener a la vez un conductor.

ALTER TABLE vehiculo
  ADD COLUMN plazas integer NOT NULL DEFAULT 4
    CHECK (plazas BETWEEN 1 AND 4);

COMMENT ON COLUMN vehiculo.plazas IS
  'Pasajeros simultáneos que admite el vehículo (máximo 4). El despacho deja '
  'de ofrecer al conductor cuando las tiene todas ocupadas.';

-- Nuevo significado de OCUPADO.
UPDATE estado
SET descripcion = 'Coche lleno: sin plazas libres, no recibe ofertas'
WHERE nombre = 'OCUPADO' AND ambito = 'conductor';

-- Los disparadores existentes cubren ahora dos casos cada uno. La clave única
-- de transicion_valida es (ambito, origen, destino, actor), así que no puede
-- haber dos filas: se aclara el texto. El motivo real de cada transición
-- concreta queda en transicion.origen_evento.
UPDATE transicion_valida
SET disparador = 'Gana la reclamación atómica y con ella se llena el coche'
WHERE ambito = 'conductor' AND estado_origen = 'OFERTADO'
  AND estado_destino = 'OCUPADO' AND actor = 'conductor';

UPDATE transicion_valida
SET disparador = 'Rechaza la oferta, o la gana y aún le quedan plazas libres'
WHERE ambito = 'conductor' AND estado_origen = 'OFERTADO'
  AND estado_destino = 'DISPONIBLE' AND actor = 'conductor';

UPDATE transicion_valida
SET disparador = 'Se libera una plaza: viaje cerrado por el conductor'
WHERE ambito = 'conductor' AND estado_origen = 'OCUPADO'
  AND estado_destino = 'DISPONIBLE' AND actor = 'conductor';

UPDATE transicion_valida
SET disparador = 'Se libera una plaza: cierre automático, cancelación o reasignación'
WHERE ambito = 'conductor' AND estado_origen = 'OCUPADO'
  AND estado_destino = 'DISPONIBLE' AND actor = 'sistema';

-- Un conductor con pasajeros a bordo no puede esperar 5 minutos a alguien que
-- no aparece: los demás van dentro del coche.
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('reloj_espera_con_pasajeros_seg', '90',
   'Reloj de espera cuando el conductor ya lleva pasajeros a bordo (R4 abreviado por compartido)');
