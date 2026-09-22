-- 061 — Un taxista que se ha unificado con otro.
--
-- Quien opera esto tenía DOS taxistas en la base: el suyo de verdad (con su
-- teléfono, su coche y sus viajes) y el «taxi del operador» que prepara
-- `/api/operador/mi-taxi` para poder conducir desde la pestaña del operador.
-- Dos identidades para la misma persona: los viajes, el recorrido y las horas
-- de servicio repartidos entre las dos, y ninguna de las dos con los números
-- de verdad.
--
-- `scripts/unificar-conductor.ts` pasa lo de uno al otro. Pero el historial
-- de estados (`transicion`) y el libro del monedero (`apunte`) son de solo
-- inserción a propósito, así que el taxista de origen no se puede borrar: se
-- queda como una cáscara que apunta a quién se unificó. Y esa marca es también
-- la que impide que el conmutador de papeles lo resucite: `mi-taxi` la sigue
-- en lugar de volver a enganchar el dispositivo al taxista viejo.

ALTER TABLE conductor
  ADD COLUMN unificado_en bigint REFERENCES conductor (id),
  ADD CONSTRAINT conductor_unificado_en_otro CHECK (unificado_en IS NULL OR unificado_en <> id);

COMMENT ON COLUMN conductor.unificado_en IS
  'Si no es NULL, este taxista se unificó con ese otro (migración 061) y ya no '
  'se usa: sus datos se pasaron allí. Queda por el historial, que no se borra.';
