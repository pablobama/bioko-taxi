-- 030 — Ocho sitios nuevos que no estaban en ninguna fuente (ni OSM, ni el
-- importador de barrios), con coordenadas que dio el operador.
--
-- Dos junto a Malabo/Baney (Pinto/Fídel Castro, Basakato de la Sagrada
-- Familia) y seis en Bioko Sur (Luba, Musola, Batete, Moka, Riaba, Baho
-- Grande) — la primera vez que la app tiene sitios fuera de Bioko Norte.
--
-- Entra igual que hace `crearZonaEnGps` (src/dominio/zonas.ts): como ZONA y
-- como REFERENCIA buscable, con la MISMA fórmula de vecindad (2500 m, mínimo
-- 3 vecinas, máximo 12) para que un barrio situado a mano y uno situado por
-- migración no queden cosidos con criterios distintos.
--
-- Nadie trabaja hoy en Luba/Riaba: sin conductores allí, quedar adyacentes a
-- su vecino real más que a un barrio de Malabo a 40 km no cambia nada del
-- reparto — pero es lo que corresponde de verdad sobre el terreno, así que
-- es lo que se calcula. Solo se tocan las parejas de los ocho nuevos: no se
-- borra ni se recalcula la adyacencia de ninguna zona existente.

DO $$
DECLARE
  vecindad_m constant double precision := 2500;
  vecinas_minimas constant integer := 3;
  vecinas_maximas constant integer := 12;
  fila record;
  nuevo_id bigint;
  nuevos_ids bigint[] := '{}';
  esta_lat double precision;
  esta_lng double precision;
  vecina record;
  i integer;
BEGIN
  FOR fila IN
    SELECT * FROM (VALUES
      ('Pinto / Fídel Castro',           'Malabo'::text, 3.7460::double precision, 8.7750::double precision),
      ('Basakato de la Sagrada Familia', 'Baney',        3.6931,                   8.8210),
      ('Luba',                           'Luba',         3.4561,                   8.5492),
      ('Musola',                         'Luba',         3.4200,                   8.6000),
      ('Batete',                         'Luba',         3.4415,                   8.5082),
      ('Moka',                           'Luba',         3.3281,                   8.6653),
      ('Riaba',                          'Riaba',        3.3850,                   8.7641),
      ('Baho Grande',                    'Riaba',        3.4000,                   8.7667)
    ) AS t(nombre, distrito, lat, lng)
  LOOP
    INSERT INTO zona (nombre, distrito, centroide_lat, centroide_lng)
    VALUES (fila.nombre, fila.distrito, fila.lat, fila.lng)
    ON CONFLICT (nombre) DO UPDATE
      SET distrito = EXCLUDED.distrito,
          centroide_lat = EXCLUDED.centroide_lat,
          centroide_lng = EXCLUDED.centroide_lng
    RETURNING id INTO nuevo_id;

    nuevos_ids := array_append(nuevos_ids, nuevo_id);

    INSERT INTO referencia (zona_id, nombre, lat, lng, categoria)
    VALUES (nuevo_id, fila.nombre, fila.lat, fila.lng, 'zona')
    ON CONFLICT (zona_id, nombre) DO UPDATE
      SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, activa = true;
  END LOOP;

  FOR i IN 1 .. array_length(nuevos_ids, 1) LOOP
    nuevo_id := nuevos_ids[i];
    SELECT centroide_lat, centroide_lng INTO esta_lat, esta_lng
    FROM zona WHERE id = nuevo_id;

    DELETE FROM zona_adyacencia WHERE zona_id = nuevo_id OR zona_adyacente_id = nuevo_id;

    FOR vecina IN
      SELECT z.id,
        2 * 6371000 * asin(sqrt(
          power(sin(radians(esta_lat - z.centroide_lat) / 2), 2)
          + cos(radians(esta_lat)) * cos(radians(z.centroide_lat))
            * power(sin(radians(esta_lng - z.centroide_lng) / 2), 2)
        )) AS d
      FROM zona z
      WHERE z.id <> nuevo_id AND z.centroide_lat IS NOT NULL AND z.centroide_lng IS NOT NULL
      ORDER BY d
      LIMIT vecinas_maximas
    LOOP
      CONTINUE WHEN vecina.d > vecindad_m
        AND (SELECT count(*) FROM zona_adyacencia WHERE zona_id = nuevo_id) >= vecinas_minimas;

      INSERT INTO zona_adyacencia (zona_id, zona_adyacente_id)
      VALUES (nuevo_id, vecina.id), (vecina.id, nuevo_id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
