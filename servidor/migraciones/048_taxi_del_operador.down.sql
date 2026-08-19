DELETE FROM oferta WHERE oleada = 4;
ALTER TABLE oferta DROP CONSTRAINT oferta_oleada_check;
ALTER TABLE oferta ADD CONSTRAINT oferta_oleada_check CHECK (oleada BETWEEN 1 AND 3);

DELETE FROM parametro WHERE clave IN ('oleada_4_seg', 'oleada_4_max_conductores');

ALTER TABLE conductor DROP COLUMN recibe_en_cualquier_zona;
