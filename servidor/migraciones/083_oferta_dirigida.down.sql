DELETE FROM transicion_valida
 WHERE ambito = 'conductor' AND estado_destino = 'OFERTADO' AND actor = 'operador';
DELETE FROM oferta WHERE oleada = 6;
ALTER TABLE oferta DROP CONSTRAINT oferta_oleada_check;
ALTER TABLE oferta ADD CONSTRAINT oferta_oleada_check CHECK (oleada BETWEEN 0 AND 5);
