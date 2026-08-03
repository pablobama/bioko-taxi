-- 035 — Borrar los barrios de Malabo que no se pudieron ubicar en ningún
-- distrito urbano, para que el operador los vuelva a dar de alta bien.
--
-- La regla no es una lista de nombres a mano, es una condición: barrio de
-- Malabo (no de Baney, Luba ni Riaba), sin distrito urbano, sin ningún
-- lugar colgando, y sin ningún viaje que apunte a su entrada del buscador.
-- Así la migración hace lo mismo aquí y en producción, aunque el catálogo
-- de cada base sea distinto.
--
-- LO QUE NO SE BORRA, y por qué:
--   - Con lugares dentro (Los Ángeles con nueve, Alcaide con dos, Abayak
--     con uno): borrarlos se llevaría por delante destinos reales como la
--     Universidad Nacional de Guinea Ecuatorial. Se quedan sin distrito
--     urbano hasta que alguien diga dónde van.
--   - Con viajes que apuntan a su entrada del buscador (Sampaka): la
--     referencia está unida a solicitudes reales y borrarla rompería el
--     historial. Se queda.
--   - Baney, Luba y Riaba enteros: son municipios y pueblos de Bioko, no
--     restos de Malabo.

DO $$
DECLARE
  id_a_borrar bigint;
  borradas integer := 0;
BEGIN
  FOR id_a_borrar IN
    SELECT z.id
    FROM zona z
    WHERE z.zona_padre_id IS NULL
      AND z.distrito = 'Malabo'
      AND z.distrito_urbano IS NULL
      -- Sin hijos: un barrio/calle colgando lo convierte en algo que
      -- alguien ya se molestó en estructurar.
      AND NOT EXISTS (SELECT 1 FROM zona h WHERE h.zona_padre_id = z.id)
      -- Sin lugares propios (su propia entrada de categoría «zona» no
      -- cuenta: la creó el sistema al situarla, no una persona).
      AND NOT EXISTS (
        SELECT 1 FROM referencia r
        WHERE r.zona_id = z.id AND r.categoria <> 'zona'
      )
      -- Sin viajes que apunten a ninguna de sus referencias.
      AND NOT EXISTS (
        SELECT 1 FROM referencia r
        JOIN solicitud s
          ON s.referencia_origen_id = r.id OR s.referencia_destino_id = r.id
        WHERE r.zona_id = z.id
      )
      -- Sin taxistas declarando que trabajan ahí ahora mismo.
      AND NOT EXISTS (SELECT 1 FROM presencia p WHERE p.zona_id = z.id)
      -- Sin bandas de precio pactadas desde o hacia ella.
      AND NOT EXISTS (
        SELECT 1 FROM banda_precio b
        WHERE b.zona_origen_id = z.id OR b.zona_destino_id = z.id
      )
  LOOP
    DELETE FROM zona_adyacencia
      WHERE zona_id = id_a_borrar OR zona_adyacente_id = id_a_borrar;
    DELETE FROM referencia WHERE zona_id = id_a_borrar;
    DELETE FROM zona WHERE id = id_a_borrar;
    borradas := borradas + 1;
  END LOOP;
  RAISE NOTICE 'Barrios de Malabo sin ubicar borrados: %', borradas;
END $$;
