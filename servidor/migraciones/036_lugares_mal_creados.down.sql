-- 036 — Revertir solo lo reversible.
--
-- Los lugares que se mudaron de zona no vuelven solos: la migración no
-- guardó de dónde venían, y volver a crear las filas de zona con el nombre
-- de un hotel sería reponer justo el error que se vino a corregir.

UPDATE zona SET distrito_urbano = NULL
WHERE nombre = 'Los Ángeles' AND zona_padre_id IS NULL;
