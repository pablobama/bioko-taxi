DELETE FROM parametro WHERE clave IN (
  'rastro_intervalo_min_seg', 'rastro_distancia_min_m',
  'rastro_anclaje_seg', 'rastro_retencion_dias'
);

DROP TABLE rastro;
