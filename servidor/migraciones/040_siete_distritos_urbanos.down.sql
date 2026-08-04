-- Vuelve a admitir los nueve del Anuario INEGE.

ALTER TABLE zona DROP CONSTRAINT zona_distrito_urbano_check;

ALTER TABLE zona ADD CONSTRAINT zona_distrito_urbano_check
  CHECK (distrito_urbano IN (
    'Malabo Centro', 'Ela Nguema', 'Semu', 'Banapá', 'Santa María',
    'Sácriba', 'Basupú del Oeste', 'Batoicopo', 'Alegre'
  ));
