-- 030 — Revertir los ocho sitios nuevos.

DO $$
DECLARE
  id_a_borrar bigint;
BEGIN
  FOR id_a_borrar IN
    SELECT id FROM zona WHERE nombre IN (
      'Pinto / Fídel Castro', 'Basakato de la Sagrada Familia',
      'Luba', 'Musola', 'Batete', 'Moka', 'Riaba', 'Baho Grande'
    )
  LOOP
    DELETE FROM zona_adyacencia WHERE zona_id = id_a_borrar OR zona_adyacente_id = id_a_borrar;
    DELETE FROM referencia WHERE zona_id = id_a_borrar;
    DELETE FROM zona WHERE id = id_a_borrar;
  END LOOP;
END $$;
