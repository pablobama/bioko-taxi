-- 025 — Trabajo de campo: situar barrios con el GPS y el papel de agente
-- (decisión de sesión, 2026-07-30).
--
-- DE DÓNDE VIENE. El importador de barrios (scripts/importar-barrios.ts) dejó
-- ocho barrios de Malabo fuera del sistema con esta nota: «Pendientes de
-- trabajo de campo (sin coordenadas en ninguna fuente)». No es que estuvieran
-- mal cargados: es que NO EXISTEN para la aplicación, porque ni OSM ni
-- ninguna otra fuente sabía dónde están. La única forma de arreglarlo es que
-- alguien vaya y lo diga desde allí — que es justo lo que ahora se puede
-- hacer desde el panel, con el GPS del propio teléfono.
--
-- Entran con centroide NULL a propósito: la lista de zonas del taxista ya
-- filtra `centroide_lat IS NOT NULL` (api/conductor.ts), así que un barrio sin
-- situar no aparece como zona de trabajo y no puede romper el reparto. Cuando
-- alguien lo sitúe, aparece solo.
--
-- EL PAPEL DE AGENTE. Un taxista de confianza que además hace trabajo de
-- campo: sitúa barrios, corrige sitios y fija los precios orientativos entre
-- zonas. Es un atributo del conductor y no una lista de uuids aparte (como
-- UUIDS_OPERADOR) porque el agente ES un conductor con su ficha, su vehículo
-- y su monedero; lo que cambia es lo que se le permite, y eso lo concede y lo
-- quita el operador desde el panel.

ALTER TABLE conductor
  ADD COLUMN es_agente boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN conductor.es_agente IS
  'Conductor que además hace trabajo de campo: situar barrios con el GPS, '
  'corregir el gazetteer y fijar bandas de precio. Lo concede el operador.';

-- Los ocho barrios que nadie supo situar. Sin coordenadas: quedan a la espera
-- de que alguien vaya con el teléfono. Si alguno ya existiera por otra vía, no
-- se toca.
INSERT INTO zona (nombre) VALUES
  ('Campo Yaundé'),
  ('Comandachina'),
  ('Pérez'),
  ('Ríocopua'),
  ('Timbabé'),
  ('Servicio'),
  ('Campamento'),
  ('Abayak')
ON CONFLICT (nombre) DO NOTHING;
