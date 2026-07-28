-- 014 — Revertir mapa, tiempo estimado y reputación

DROP INDEX IF EXISTS valoracion_por_conductor;
DELETE FROM parametro WHERE clave IN ('velocidad_urbana_kmh', 'eta_factor_desvio');
