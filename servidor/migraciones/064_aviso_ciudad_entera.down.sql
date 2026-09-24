-- Las ofertas de la oleada 5 que ya existan se quedan sin sitio en el CHECK,
-- así que vuelven a la 4: la oleada es informativa, y una carrera repartida no
-- se borra por revertir un parámetro.
UPDATE oferta SET oleada = 4 WHERE oleada = 5;
ALTER TABLE oferta DROP CONSTRAINT oferta_oleada_check;
ALTER TABLE oferta ADD CONSTRAINT oferta_oleada_check CHECK (oleada BETWEEN 0 AND 4);
DELETE FROM parametro WHERE clave IN
  ('aviso_ciudad_entera', 'oleada_5_seg', 'oleada_5_max_conductores');
