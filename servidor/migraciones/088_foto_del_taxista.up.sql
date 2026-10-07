-- 088 — La foto del taxista (08/10).
--
-- Para que el operador reconozca al taxista en la ficha. Va en la base, como
-- el audio de la radio (migración 075) y por el mismo motivo: reducida a un
-- lado de 400 px antes de subirla, una foto de carnet pesa unas decenas de KB,
-- y con unos cientos de taxistas todo lo guardado cabe en unos pocos MB. Meter
-- un almacén de objetos aparte por eso serían otra credencial, otro servicio
-- que se cae solo y otra copia de seguridad — coste que no compensa a esta
-- escala.
--
-- La reducción se hace en el NAVEGADOR del operador (un canvas) antes de
-- subirla: así no hace falta una librería de imágenes en el servidor, y lo que
-- viaja por la red ya es pequeño.

ALTER TABLE conductor ADD COLUMN foto bytea;
-- El tipo de imagen tal como la exportó el navegador (image/jpeg casi siempre).
-- Se guarda para servirla con la cabecera correcta.
ALTER TABLE conductor ADD COLUMN foto_tipo text;

COMMENT ON COLUMN conductor.foto IS
  'Foto del taxista, reducida a ~400 px en el navegador antes de subirla '
  '(migración 088). En la base como el audio de la radio: a esta escala cabe '
  'de sobra y evita un servicio de almacenamiento aparte.';
