-- 040 — Los distritos urbanos son siete, no nueve.
--
-- La migración 033 metió en la lista los nueve que da la fuente oficial
-- (Anuario INEGE), incluidos Basupú del Oeste y Batoicopo. El operador, que
-- vive aquí, corrige: esos dos están en Baney, no en Malabo. Ya se dejaron a
-- NULL entonces por esa contradicción, así que ninguna zona los usa; lo que
-- faltaba era quitarlos también de lo que la base acepta, para que no vuelvan
-- a colarse por un UPDATE distraído.
--
-- Quedan los siete que el operador reconoce sobre el terreno:
--   Malabo Centro, Ela Nguema, Semu, Banapá, Santa María, Sácriba, Alegre

DO $$
DECLARE
  usados text;
BEGIN
  SELECT string_agg(DISTINCT nombre, ', ') INTO usados
  FROM zona
  WHERE distrito_urbano IN ('Basupú del Oeste', 'Batoicopo');

  IF usados IS NOT NULL THEN
    RAISE EXCEPTION
      'Hay zonas en Basupú del Oeste o Batoicopo (%): hay que reasignarlas antes de quitar esos distritos urbanos.',
      usados;
  END IF;
END $$;

ALTER TABLE zona DROP CONSTRAINT zona_distrito_urbano_check;

ALTER TABLE zona ADD CONSTRAINT zona_distrito_urbano_check
  CHECK (distrito_urbano IN (
    'Malabo Centro', 'Ela Nguema', 'Semu', 'Banapá', 'Santa María',
    'Sácriba', 'Alegre'
  ));

COMMENT ON COLUMN zona.distrito_urbano IS
  'Distrito urbano de Malabo (migraciones 033 y 040): los siete que el '
  'operador reconoce sobre el terreno. NULL para lo que está fuera de la '
  'ciudad —Baney, Luba, Riaba no tienen distritos urbanos— y para lo que '
  'queda por asignar. Etiqueta organizativa: el reparto no la usa, sigue '
  'funcionando por barrio y adyacencia.';
