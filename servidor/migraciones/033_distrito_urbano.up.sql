-- 033 — Distrito urbano: el nivel oficial que faltaba entre el distrito y el
-- barrio.
--
-- El distrito administrativo de Malabo se organiza en NUEVE distritos
-- urbanos: los cinco numerados de la ciudad (Ley 4/2017 según el Anuario
-- INEGE 2018; otras publicaciones oficiales citan la 3/2017, discrepancia
-- que la fuente deja documentada sin resolver) más Sácriba, Basupú del
-- Oeste, Batoicopo, y Alegre —este último elevado a distrito urbano por la
-- Ley 5/2025, de 16 de julio, segregándolo de Basupú del Oeste—.
--
-- Se guardan por su nombre de uso, no por su número: nadie pide un taxi al
-- «Distrito Urbano número III». Cada nombre sale de la propia fuente
-- oficial: el DU II se documenta como Ela Nguema; la alcaldía del III se
-- asocia a Semu; el punto representativo del IV son las Viviendas Sociales
-- de Banapá; el despacho del alcalde del V está en Santa María; y el I es
-- el casco histórico, que aquí se ha llamado siempre Malabo Centro.
--
-- ES UNA ETIQUETA, NO UN NIVEL DE REPARTO. Igual que `distrito` (migración
-- 029): el reparto sigue funcionando por barrio y su adyacencia. Un
-- distrito urbano de 16 km² —como el V— como unidad de búsqueda diría «hay
-- un taxi en tu zona» teniendo el taxi a ocho kilómetros. Esto solo sirve
-- para ordenar la lista del panel y para que el catálogo refleje la
-- estructura administrativa real.
--
-- Solo se rellena lo que la fuente documenta con confianza alta o media.
-- Lo que la fuente marca como inferencia espacial de confianza baja
-- (La Begoña, Buena Esperanza, Basupú Fishtown, Alcaide, Los Ángeles) se
-- deja a NULL: es una suposición por cercanía, no un dato, y adivinar aquí
-- es peor que no decir nada.

ALTER TABLE zona
  ADD COLUMN distrito_urbano text CHECK (distrito_urbano IN (
    'Malabo Centro', 'Ela Nguema', 'Semu', 'Banapá', 'Santa María',
    'Sácriba', 'Basupú del Oeste', 'Batoicopo', 'Alegre'
  ));

COMMENT ON COLUMN zona.distrito_urbano IS
  'Distrito urbano oficial (migración 033), por su nombre de uso. NULL: no '
  'se pudo confirmar con una fuente. Etiqueta organizativa — el reparto no '
  'la usa, sigue funcionando por barrio y adyacencia.';

-- Distrito urbano nº I — el casco histórico.
UPDATE zona SET distrito_urbano = 'Malabo Centro'
WHERE nombre = 'Malabo Centro';

-- Nº II — documentado en fuente oficial como «Ela Nguema».
UPDATE zona SET distrito_urbano = 'Ela Nguema'
WHERE nombre = 'Ela Nguema';

-- Nº III — la alcaldía del III se asocia a Semu (fuente institucional).
UPDATE zona SET distrito_urbano = 'Semu'
WHERE nombre = 'Semu';

-- Nº IV — Campo Yaundé y Banapá con mención institucional expresa.
UPDATE zona SET distrito_urbano = 'Banapá', distrito = 'Malabo'
WHERE nombre IN ('Banapá', 'Campo Yaundé');

-- Nº V — Santa María (sede del alcalde), Paraíso (mención oficial) y
-- Caracolas (inferencia por proximidad, confianza media).
UPDATE zona SET distrito_urbano = 'Santa María'
WHERE nombre IN ('Santa María', 'Paraíso', 'Caracolas');

-- Los cuatro periféricos: la cabecera lleva el nombre del distrito urbano.
-- «Sacriba» sin tilde es como entró por el importador; el nombre oficial
-- lleva tilde y es el que va en la etiqueta.
UPDATE zona SET distrito_urbano = 'Sácriba'
WHERE nombre IN ('Sacriba', 'Sácriba');

-- Alegre: el dato abierto lo rotula «Alegría» y la fuente pide confirmar la
-- equivalencia con cartografía oficial. Se aplica porque las coordenadas
-- coinciden exactamente y la ley que lo crea sí está identificada.
UPDATE zona SET distrito_urbano = 'Alegre', distrito = 'Malabo'
WHERE nombre IN ('Alegría', 'Alegre');

-- Batoicopo y Basupú del Oeste NO se tocan aquí a propósito: la fuente
-- oficial los da como distritos urbanos de Malabo, pero en esta base están
-- marcados como distrito «Baney» por indicación del operador. Hasta
-- resolver esa contradicción, dejarlos a NULL es lo honesto.
