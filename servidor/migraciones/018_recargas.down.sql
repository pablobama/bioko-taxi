-- 018 — Revertir las solicitudes de recarga

DELETE FROM parametro WHERE clave IN (
  'muni_dinero_numero', 'muni_dinero_titular',
  'recarga_minima_xaf', 'recarga_caducidad_horas'
);
DROP TABLE IF EXISTS recarga;
