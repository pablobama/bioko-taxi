-- 025 — Revertir el trabajo de campo.
--
-- Los barrios que alguien ya haya situado NO se borran: son trabajo de campo
-- real, y su fila puede tener referencias y solicitudes colgando. Se borran
-- solo los que siguen sin situar, que es exactamente lo que esta migración
-- añadió y nadie ha tocado.

DELETE FROM zona
WHERE centroide_lat IS NULL
  AND nombre IN ('Campo Yaundé', 'Comandachina', 'Pérez', 'Ríocopua',
                 'Timbabé', 'Servicio', 'Campamento', 'Abayak')
  AND NOT EXISTS (SELECT 1 FROM referencia r WHERE r.zona_id = zona.id);

ALTER TABLE conductor DROP COLUMN IF EXISTS es_agente;
