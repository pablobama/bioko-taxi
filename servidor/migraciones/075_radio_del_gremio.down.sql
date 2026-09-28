DELETE FROM parametro WHERE clave IN (
  'radio_activada', 'radio_segundos_max', 'radio_turno_margen_seg',
  'radio_guardado_horas', 'radio_bytes_max', 'radio_mensajes_por_minuto'
);

DROP TABLE IF EXISTS radio_uso;
DROP TABLE IF EXISTS mensaje_voz;
DROP TABLE IF EXISTS turno_palabra;
