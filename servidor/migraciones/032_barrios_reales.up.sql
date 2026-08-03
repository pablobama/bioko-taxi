-- 032 — Los cuatro barrios/calle reales que dio el operador (migración 031).
--
-- Sin coordenadas: no las dio, y no se inventan (mismo criterio que los
-- barrios "pendientes de trabajo de campo" de la migración 025). Aparecen en
-- el panel como pendientes de situar; no participan en el reparto hasta
-- entonces ni aunque se sitúen, porque tienen padre (zona_padre_id).
--
-- No se crean los lugares de ejemplo que dio junto a estos (Hotel Ilachi,
-- Iglesia Católica, Cold Water, Clínica Dr. Alfredo): `referencia.lat/lng`
-- son obligatorios y no hay coordenadas para ellos. Quedan para que el
-- operador los añada desde «Lugares» cuando tenga el GPS.

INSERT INTO zona (nombre, distrito, zona_padre_id)
SELECT v.nombre, padre.distrito, padre.id
FROM (VALUES
  ('Barrio Bisinga',   'Ela Nguema'),
  ('Barrio Argentina', 'Ela Nguema'),
  ('San Juan',         'Semu'),
  ('Calle Mongomo',    'Malabo Centro')
) AS v(nombre, padre_nombre)
JOIN zona padre ON padre.nombre = v.padre_nombre
ON CONFLICT (nombre) DO UPDATE
  SET zona_padre_id = EXCLUDED.zona_padre_id,
      distrito = EXCLUDED.distrito;
