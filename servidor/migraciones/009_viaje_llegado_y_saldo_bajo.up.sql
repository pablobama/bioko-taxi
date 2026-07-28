-- 009 — Soporte del protocolo de encuentro (R4) y del aviso de saldo bajo (D4).

-- Momento en que el conductor pulsó «he llegado»: arranca el reloj de espera
-- de 5 minutos visible para ambos. También alimenta la métrica de presencia
-- falsa (tiempo aceptado → he llegado, R6).
ALTER TABLE viaje ADD COLUMN llegado_en timestamptz;

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('umbral_saldo_bajo_xaf', '300', 'Por debajo de este saldo se emite el aviso D4 al conductor (3 comisiones)');
