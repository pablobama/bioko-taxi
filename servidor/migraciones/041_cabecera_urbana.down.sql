DROP INDEX zona_una_cabecera_por_distrito;
ALTER TABLE zona DROP CONSTRAINT zona_cabecera_coherente;
ALTER TABLE zona DROP COLUMN es_cabecera_urbana;
