-- 012 — Eliminar el reporte de precio (decisión de sesión, 2026-07-26).
--
-- Motivo: reducir fricción. Con el modelo de suscripción la plataforma no
-- necesita saber cuánto se pagó: sus ingresos no dependen del viaje y el
-- dinero nunca pasa por aquí. El pasajero cierra sin escribir nada y el
-- conductor tampoco.
--
-- Consecuencia asumida: banda_precio ya no puede calcularse de datos reales.
-- La tabla se conserva y pasa a ser CURADA POR EL OPERADOR (mismo criterio
-- que el gazetteer: trabajo de campo editable sin desplegar). El conductor
-- sigue viendo la banda en el broadcast para no aceptar a ciegas (R2).

ALTER TABLE viaje
  DROP COLUMN precio_reportado_cliente,
  DROP COLUMN precio_reportado_conductor;

COMMENT ON TABLE banda_precio IS
  'Bandas orientativas por par de zonas. Desde la migración 012 las mantiene '
  'el operador a mano (antes se calculaban de los precios reportados). Nunca '
  'es una tarifa impuesta: el precio lo negocian pasajero y conductor.';
