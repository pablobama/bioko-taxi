-- 026 — Comprobar la precisión del GPS al situar un barrio (P25-02).
--
-- EL PROBLEMA. La migración 025 comprueba que las coordenadas caigan dentro
-- del recuadro de Malabo, y eso descarta lo grosero: el (0,0) de un GPS sin
-- fijar y la posición de otro país. Pero no descarta lo peligroso, que es un
-- punto DENTRO de Malabo y aun así muy malo.
--
-- Un teléfono contesta con lo que tenga: si el GPS todavía no ha fijado
-- satélites, responde con la celda de telefonía o con la wifi, y eso en la
-- práctica es un radio de cientos o miles de metros. Cae dentro del recuadro,
-- así que pasaba la comprobación y el barrio quedaba situado a medio kilómetro
-- de donde está — sin que nadie se enterase, porque el número guardado parece
-- igual de bueno que uno tomado con doce satélites.
--
-- Y no es cosmético: el centroide decide qué barrios son vecinos (la tercera
-- oleada del reparto) y cuál se le ofrece primero al taxista por cercanía. Un
-- barrio mal situado manda taxis al sitio equivocado durante meses.
--
-- QUÉ SE GUARDA. La precisión declarada por el navegador (`coords.accuracy`,
-- el radio en metros con 95 % de confianza). Se guarda ADEMÁS de validarla,
-- para poder mirar después qué barrios se situaron con buena señal y cuáles
-- convendría repetir. NULL en los que ya estaban: no se sabe, y fingir un
-- número sería peor.

ALTER TABLE zona
  ADD COLUMN precision_gps_m double precision;

COMMENT ON COLUMN zona.precision_gps_m IS
  'Radio de error en metros que declaró el teléfono al situar el barrio '
  '(coords.accuracy). NULL en los cargados por el importador o antes de la '
  'migración 026: no se sabe con qué precisión se tomaron.';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('gps_precision_maxima_m', '50',
   'Radio de error máximo aceptable al situar un barrio con el GPS (P25-02)');
