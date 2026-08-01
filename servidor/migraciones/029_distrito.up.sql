-- 029 — Distrito de cada barrio (Bioko: Malabo, Baney, Luba, Riaba).
--
-- Cuatro distritos, no cinco: Moka aparece en todas las fuentes como
-- localidad/ciudad principal, pero ninguna la confirma como distrito
-- administrativo propio, así que se guarda como barrio DENTRO de Luba, que
-- es coherente con la propia relación de barrios que llegó para poblar esto.
--
-- No es un nivel jerárquico nuevo (no hay tabla «distrito»): es una columna
-- de zona. El reparto (adyacencia, oleadas) no la usa ni la necesita, es
-- puramente organizativa — para poder agrupar la lista de zonas en el panel
-- de operador en vez de tener setenta nombres sueltos sin orden.
--
-- Solo se rellena lo que se pudo confirmar por nombre exacto o por una
-- variante reconocible del mismo sitio (p. ej. «Puerto» → Puerto Nuevo +
-- Puerto Viejo, «San Juan» → Urbanización San Juan). Lo que no se pudo
-- casar con ningún barrio existente queda NULL a propósito: adivinar el
-- distrito de un barrio es peor que no decir nada.

ALTER TABLE zona
  ADD COLUMN distrito text CHECK (distrito IN ('Malabo', 'Baney', 'Luba', 'Riaba'));

COMMENT ON COLUMN zona.distrito IS
  'Agrupación puramente organizativa para la lista del operador. NULL: no '
  'se pudo confirmar con una fuente o con los datos que dio el operador.';

UPDATE zona SET distrito = 'Malabo' WHERE nombre IN (
  'Malabo Centro', 'Ela Nguema', 'Los Ángeles', 'Sampaka', 'Sipopo',
  'Alcaide', 'Abayak', 'Balorei', 'Campamento', 'Servicio', 'Pérez',
  'Ríocopua', 'Timbabé', 'Vitacana Makeda', 'Sacriba', 'Semu', 'Caracolas',
  'Buena Esperanza', 'Paraíso', 'Santa María', 'Puerto Nuevo', 'Puerto Viejo',
  'Campo Yaundé', 'Barrio Chino', 'La Begoña', 'Urbanización San Juan'
);

UPDATE zona SET distrito = 'Baney' WHERE nombre IN (
  'Baney', 'Rebola', 'Basupú Fishtown', 'Basupú del Oeste', 'Bacake Grande',
  'Bacake Pequeño', 'Basacato del Este', 'Basacato del Oeste', 'Basapo',
  'Basilé', 'Basuala', 'Baó Basuala', 'Batoicopo'
);
