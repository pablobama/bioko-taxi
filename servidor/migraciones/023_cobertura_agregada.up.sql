-- 023 — Parámetros de la cobertura agregada (decisión de sesión, 2026-07-30).
--
-- Dos vistas nuevas, las dos SIEMPRE agregadas por zona y nunca por persona:
--
--   - El taxista ve en qué barrios se está pidiendo taxi, para conducir hacia
--     el trabajo en vez de dar vueltas. Ataca el SIN_OFERTA, que es la mayor
--     fuga de ingresos del sistema.
--   - El pasajero ve cuántos taxis podrían venir a por él ANTES de pedir, en
--     vez de esperar 90 s para que le digan que no hay ninguno.
--
-- LO QUE NO SE HACE, Y POR QUÉ (evaluación del 2026-07-30):
--
--   - Nunca se muestra un taxi concreto en el mapa del pasajero. Un punto que
--     se puede seguir es una herramienta de acoso y de robo —un taxi libre y
--     solo en una calle tranquila de noche es un objetivo descrito—, el
--     anonimato del punto es falso cuando en el barrio solo hay dos, y como
--     el registro no es autenticación (P15-04) cualquiera puede mirar. Además
--     invita a caminar hasta el taxi y pararlo en la calle: la plataforma
--     cobra por viaje completado, así que el punto se come su propio ingreso.
--   - Nunca se muestra un pasajero concreto al taxista. Un pin diría «una
--     persona, sola, en esta dirección, ahora mismo», y el alta de conductor
--     hoy se auto-verifica sin que nadie revise nada.
--
-- El umbral existe para que un número pequeño no delate a una persona: en un
-- barrio con una sola solicitud, decir «aquí hay demanda» es casi señalarla.

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('demanda_ventana_min', '30',
   'Minutos de solicitudes que se miran para decir dónde hay demanda (sección 11)'),
  ('demanda_minima_zona', '3',
   'Solicitudes mínimas en la ventana para nombrar una zona: menos delataría a una persona'),
  ('cobertura_frescura_seg', '45',
   'Segundos que un conteo de taxis cerca se considera fresco; más viejo, no se enseña');
