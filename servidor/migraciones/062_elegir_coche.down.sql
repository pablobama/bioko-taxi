ALTER TABLE oferta DROP CONSTRAINT oferta_oleada_check;
ALTER TABLE oferta ADD CONSTRAINT oferta_oleada_check CHECK (oleada BETWEEN 1 AND 4);
DELETE FROM parametro WHERE clave = 'oleada_elegido_seg';
ALTER TABLE solicitud DROP COLUMN conductor_elegido_id;
