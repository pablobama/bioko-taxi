-- 093 — La foto del dueño (12/10).
--
-- Igual que la del taxista (migración 088) y por lo mismo: para reconocer al
-- dueño en la ficha. Se reduce en el navegador antes de subirla, así que pesa
-- poco y cabe en la base sin montar un almacén de objetos aparte.

ALTER TABLE propietario ADD COLUMN foto bytea;
-- El tipo de imagen tal como lo exportó el navegador (image/jpeg casi siempre),
-- para servirla con la cabecera correcta.
ALTER TABLE propietario ADD COLUMN foto_tipo text;
