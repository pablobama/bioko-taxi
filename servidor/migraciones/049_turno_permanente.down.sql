DELETE FROM parametro WHERE clave IN ('aviso_turno_horas', 'abandono_servicio_horas');

ALTER TABLE presencia
  DROP COLUMN en_servicio_desde,
  DROP COLUMN avisado_turno_en;
