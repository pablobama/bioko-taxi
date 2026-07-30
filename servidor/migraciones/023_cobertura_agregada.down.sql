-- 023 — Revertir los parámetros de la cobertura agregada.

DELETE FROM parametro WHERE clave IN (
  'demanda_ventana_min', 'demanda_minima_zona', 'cobertura_frescura_seg'
);
