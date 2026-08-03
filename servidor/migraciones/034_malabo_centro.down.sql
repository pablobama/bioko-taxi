-- 034 — Revertir los barrios de Malabo Centro.

UPDATE zona SET distrito_urbano = NULL
WHERE zona_padre_id IS NULL
  AND nombre IN (
    'Barrio Chino', 'Campamento', 'Puerto Nuevo', 'Puerto Viejo',
    'Servicio', 'Área Presidencial', 'Seis Casas', 'Comandachina'
  );
