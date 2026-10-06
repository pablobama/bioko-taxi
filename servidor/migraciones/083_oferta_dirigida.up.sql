-- 083 — La oferta dirigida necesita sitio en el CHECK (06/10).
--
-- Desde la mesa de despacho, el operador puede mandarle una carrera concreta
-- a un taxi concreto: la OLEADA 6. No es asignar a dedo —el taxista la recibe
-- como cualquier oferta y decide él—, y va fuera de la contabilidad de las
-- oleadas 1-4 para que el reparto automático siga su curso como si no
-- existiera.
--
-- Es la tercera vez que este CHECK crece (0 en la 062, 4 en la 048, 5 en la
-- 064), y está bien que sea un CHECK y no un texto libre: cada número nuevo
-- obliga a pasar por aquí y dejar escrito qué significa.

ALTER TABLE oferta DROP CONSTRAINT oferta_oleada_check;
ALTER TABLE oferta ADD CONSTRAINT oferta_oleada_check CHECK (oleada BETWEEN 0 AND 6);

COMMENT ON COLUMN oferta.oleada IS
  '0: el coche elegido por el pasajero (062). 1-3: barrio y vecinos. 4: los '
  'que reciben de toda la isla (048). 5: aviso a la ciudad entera (064). '
  '6: dirigida por el operador desde la mesa (083).';

-- Y el catálogo de transiciones tiene que conocer al nuevo actor del gesto:
-- hasta hoy, a OFERTADO solo llevaba el reloj de oleadas ('sistema').
INSERT INTO transicion_valida (ambito, estado_origen, estado_destino, actor, disparador) VALUES
  ('conductor', 'DISPONIBLE', 'OFERTADO', 'operador',
   'Oferta dirigida desde la mesa de despacho (083)'),
  -- OFERTADO → OFERTADO ya existía para 'sistema' (varias oleadas alcanzan al
  -- mismo conductor); la mesa puede dirigirle otra carrera igual.
  ('conductor', 'OFERTADO', 'OFERTADO', 'operador',
   'Oferta dirigida a un conductor que ya tenía otra delante (083)');
