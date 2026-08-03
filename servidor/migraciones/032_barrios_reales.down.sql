-- 032 — Revertir los cuatro barrios/calle reales.

DELETE FROM zona
WHERE nombre IN ('Barrio Bisinga', 'Barrio Argentina', 'San Juan', 'Calle Mongomo')
  AND zona_padre_id IS NOT NULL;
