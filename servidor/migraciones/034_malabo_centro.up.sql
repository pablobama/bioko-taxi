-- 034 — Los barrios del distrito urbano de Malabo Centro, según el operador.
--
-- La fuente oficial (Anuario INEGE 2018) describe los límites del Distrito
-- Urbano número I en prosa —«norte: Océano Atlántico, sur: Calle la Ronda–
-- río Cónsul…»— pero no publica el polígono, así que no hay forma de
-- calcular qué barrio cae dentro. Esta lista la da el operador, que conoce
-- la ciudad.
--
-- Batoicopo y Basupú del Oeste NO se tocan: la fuente oficial los da como
-- distritos urbanos del distrito administrativo de Malabo, pero el operador
-- confirma que están en Baney, y es quien conoce el terreno. Se quedan con
-- distrito «Baney» y sin distrito urbano.

UPDATE zona SET distrito_urbano = 'Malabo Centro', distrito = 'Malabo'
WHERE zona_padre_id IS NULL
  AND nombre IN (
    'Barrio Chino', 'Campamento', 'Puerto Nuevo', 'Puerto Viejo',
    'Servicio', 'Área Presidencial', 'Seis Casas', 'Comandachina'
  );
