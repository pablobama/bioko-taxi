-- 022 — Resolución de incidencias desde el panel de operador (P21-01).
--
-- La tabla incidencia ya tenía resuelta_por/resuelta_en, pero no registraba
-- QUÉ se decidió. Sin eso, la auditoría dice quién y cuándo pero no qué:
-- «sancionado» y «perdonado» quedaban indistinguibles.

ALTER TABLE incidencia ADD COLUMN resolucion text
  CHECK (resolucion IN ('sancionado', 'perdonado'));

-- La cola del operador es «las no resueltas, la más vieja primero».
CREATE INDEX incidencia_pendientes ON incidencia (creada_en)
  WHERE resuelta_en IS NULL;
