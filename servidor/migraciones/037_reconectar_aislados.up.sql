-- 037 — Recoser cualquier barrio que se haya quedado sin vecinas.
--
-- Ha pasado dos veces al limpiar el catálogo: se borra un grupo de barrios
-- y alguno de los que quedan pierde a TODAS sus vecinas. Un barrio sin
-- vecinas es invisible para el reparto —la tercera oleada no tiene a dónde
-- extenderse—, así que devuelve «no hay taxi» aunque haya uno a cuatro
-- calles. Y no avisa: hay que acordarse de mirarlo.
--
-- Esta migración lo arregla y es idempotente: si no hay ninguno aislado no
-- toca nada, así que puede volver a correrse tras cualquier limpieza.
--
-- Misma fórmula que `recoserAdyacencia` en src/dominio/zonas.ts, y a
-- propósito: 2.500 m de vecindad, mínimo tres vecinas aunque queden lejos
-- —antes lejos que aislado— y máximo doce, para que la tercera oleada
-- siga siendo «los de al lado» y no media isla. Si las dos fórmulas se
-- separan, el mapa acaba cosido con dos criterios distintos según quién lo
-- tocara.
--
-- Solo entre barrios (zona_padre_id IS NULL): una calle o sub-barrio
-- (migración 031) no tiene adyacencia propia ni la necesita.

WITH aisladas AS (
  SELECT z.id, z.centroide_lat AS lat, z.centroide_lng AS lng
  FROM zona z
  WHERE z.zona_padre_id IS NULL
    AND z.centroide_lat IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM zona_adyacencia a WHERE a.zona_id = z.id)
),
distancias AS (
  SELECT a.id AS zona_id,
         v.id AS vecina_id,
         2 * 6371000 * asin(sqrt(
           power(sin(radians(a.lat - v.centroide_lat) / 2), 2)
           + cos(radians(a.lat)) * cos(radians(v.centroide_lat))
             * power(sin(radians(a.lng - v.centroide_lng) / 2), 2)
         )) AS d
  FROM aisladas a
  JOIN zona v
    ON v.id <> a.id
   AND v.zona_padre_id IS NULL
   AND v.centroide_lat IS NOT NULL
   AND v.centroide_lng IS NOT NULL
),
ordenadas AS (
  SELECT zona_id, vecina_id, d,
         row_number() OVER (PARTITION BY zona_id ORDER BY d) AS puesto
  FROM distancias
),
elegidas AS (
  SELECT zona_id, vecina_id
  FROM ordenadas
  WHERE puesto <= 12
    AND (d <= 2500 OR puesto <= 3)
)
-- En los dos sentidos: es lo que espera la consulta del reparto.
INSERT INTO zona_adyacencia (zona_id, zona_adyacente_id)
SELECT zona_id, vecina_id FROM elegidas
UNION
SELECT vecina_id, zona_id FROM elegidas
ON CONFLICT DO NOTHING;
