ALTER TABLE oferta
  DROP COLUMN desvio_retraso_seg,
  DROP COLUMN desvio_espera_seg,
  DROP COLUMN desvio_metros;
DELETE FROM parametro WHERE clave IN
  ('desvio_filtra', 'desvio_retraso_max_seg', 'desvio_retraso_max_pct', 'desvio_espera_max_seg');
