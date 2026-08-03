-- 031 — Barrio/calle: el nivel que faltaba entre distrito urbano y lugar.
--
-- No hace falta columna nueva: `zona.zona_padre_id` existe desde la
-- migración 003 (autorreferencia a zona.id) y hasta hoy ningún código la
-- leía ni la escribía. Es exactamente el hueco que hace falta.
--
-- La jerarquía completa queda: Malabo/Baney/Luba/Riaba (zona.distrito) →
-- distrito urbano (lo que hasta ahora se llamaba «zona» sin más: Ela
-- Nguema, Semu, Malabo Centro...) → barrio/calle (fila de zona CON
-- zona_padre_id: Barrio Bisinga, Calle Mongomo...) → lugar (referencia).
--
-- El reparto NO se toca: solo las zonas sin padre participan en
-- zona_adyacencia y en la presencia de los conductores (ver
-- src/dominio/zonas.ts y src/api/conductor.ts). Un barrio/calle nunca
-- recibe vecinas ni aparece en el selector de «dónde trabajas» del
-- taxista — un lugar colgado de él se resuelve hacia su distrito urbano
-- padre antes de repartir (despacho.ts, cobertura.ts, banda de precio).
--
-- Solo un nivel de hijos: no hay nietos. Se valida en la API, no aquí, por
-- el mismo motivo que la categoría de una referencia se valida en la API
-- (servidor/src/api/operador.ts) — un CHECK no puede mirar la fila padre.

COMMENT ON COLUMN zona.zona_padre_id IS
  'Barrio/calle dentro de un distrito urbano (migración 031). NULL: esta '
  'fila ES el distrito urbano (lo que el reparto sigue llamando "zona"). '
  'Con valor: barrio/calle sin adyacencia propia, nunca elegible como '
  '"dónde trabajas" — solo sirve para clasificar lugares con más '
  'precisión. Solo un nivel: el padre de un padre no puede tener padre.';
