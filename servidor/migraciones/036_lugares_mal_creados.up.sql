-- 036 — Lugares que se dieron de alta como barrios, devueltos a su sitio.
--
-- Pasó lo previsible: quien estaba en la calle usó «Estoy aquí: crear
-- barrio» para dar de alta un sitio. El resultado es una fila de `zona` con
-- el nombre de un hotel o de un bar, que además aparece en el selector de
-- «dónde trabajas» del taxista. Aquí cada uno vuelve a ser lo que es: un
-- lugar dentro del barrio que le corresponde.
--
-- Hotel Ilachi va a Barrio Bisinga y no a Ela Nguema a secas porque el
-- operador lo situó ahí expresamente al describir la jerarquía.
--
-- Las categorías de Cine Mar («otro», no hay categoría para cines) y de la
-- Rotonda María Cano («plaza») son la mejor aproximación con la lista de
-- categorías que existe; se pueden corregir desde el panel.
--
-- Nada se borra a ciegas: si la entrada del sitio está unida a viajes ya
-- hechos, la fila de zona se queda y se avisa por consola, en vez de
-- reventar la migración o romper el historial.

DO $$
DECLARE
  caso record;
  id_zona bigint;
  id_destino bigint;
  lat double precision;
  lng double precision;
  movidas integer;
  con_viajes integer;
BEGIN
  FOR caso IN
    SELECT * FROM (VALUES
      ('Hotel Ilachi',       'Barrio Bisinga', 'hotel'),
      ('Cine Mar',           'Ela Nguema',     'otro'),
      ('Tamara de Semu',     'Semu',           'restaurante'),
      ('Rotonda María Cano', 'Sampaka',        'plaza')
    ) AS t(zona_mal, barrio_destino, categoria)
  LOOP
    id_zona := NULL;
    id_destino := NULL;
    lat := NULL;
    lng := NULL;

    SELECT z.id, z.centroide_lat, z.centroide_lng
      INTO id_zona, lat, lng
      FROM zona z WHERE z.nombre = caso.zona_mal AND z.zona_padre_id IS NULL;
    CONTINUE WHEN id_zona IS NULL;

    SELECT z.id INTO id_destino FROM zona z WHERE z.nombre = caso.barrio_destino;
    IF id_destino IS NULL THEN
      RAISE NOTICE 'No existe el barrio destino «%», se deja «%» como estaba.',
        caso.barrio_destino, caso.zona_mal;
      CONTINUE;
    END IF;

    -- El lugar que ya existía dentro de esa zona se muda al barrio bueno.
    UPDATE referencia r SET zona_id = id_destino
    WHERE r.zona_id = id_zona AND r.categoria <> 'zona'
      AND NOT EXISTS (
        SELECT 1 FROM referencia r2
        WHERE r2.zona_id = id_destino AND r2.nombre = r.nombre
      );
    GET DIAGNOSTICS movidas = ROW_COUNT;

    -- Si no había lugar —solo la entrada que crea el sistema al situar un
    -- barrio—, se crea con las coordenadas que ya se tomaron sobre el
    -- terreno: son buenas, lo que estaba mal era el nivel.
    IF movidas = 0 AND lat IS NOT NULL AND lng IS NOT NULL THEN
      INSERT INTO referencia (zona_id, nombre, lat, lng, categoria)
      VALUES (id_destino, caso.zona_mal, lat, lng, caso.categoria)
      ON CONFLICT (zona_id, nombre) DO NOTHING;
    END IF;

    -- ¿Queda algo unido a viajes reales? Entonces la zona no se toca.
    SELECT count(*) INTO con_viajes
    FROM referencia r
    JOIN solicitud s
      ON s.referencia_origen_id = r.id OR s.referencia_destino_id = r.id
    WHERE r.zona_id = id_zona;

    IF con_viajes > 0 THEN
      RAISE NOTICE '«%» tiene % viaje(s) enganchado(s): se queda como zona.',
        caso.zona_mal, con_viajes;
      CONTINUE;
    END IF;

    DELETE FROM zona_adyacencia WHERE zona_id = id_zona OR zona_adyacente_id = id_zona;
    DELETE FROM referencia WHERE zona_id = id_zona;
    DELETE FROM zona WHERE id = id_zona;
  END LOOP;
END $$;

-- Los Ángeles es un barrio del distrito urbano del centro.
UPDATE zona SET distrito_urbano = 'Malabo Centro'
WHERE nombre = 'Los Ángeles' AND zona_padre_id IS NULL;
