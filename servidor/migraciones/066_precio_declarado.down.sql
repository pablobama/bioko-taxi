DROP TABLE precio_declarado;
ALTER TABLE valoracion DROP COLUMN cobro_de_mas;
DELETE FROM parametro WHERE clave IN
  ('banda_muestras_minimas', 'banda_ventana_dias', 'valoracion_pendiente_dias',
   'alarma_cobros_de_mas');
-- Las bandas calculadas se quedan: son números buenos. Solo se les borra la
-- marca de cuántas respuestas las produjeron, que es la columna que vuelve a
-- quedarse sin uso.
UPDATE banda_precio SET muestras = 0;
