DROP INDEX referencia_publicas;
ALTER TABLE referencia
  DROP COLUMN propuesta_en,
  DROP COLUMN propuesta_por_dispositivo_id,
  DROP COLUMN aprobada_en;
ALTER TABLE perfil_cliente DROP COLUMN es_agente;
DELETE FROM parametro WHERE clave IN
  ('sitio_propuesto_usos_para_publicar', 'sitio_propuesto_mismo_m');
