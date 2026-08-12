-- 045 — RLS en las tablas que llegaron después de la 039.
--
-- La 039 cerró la API pública de Supabase activando RLS en todas las tablas…
-- que existían ESE día. `rastro` (042), `seguimiento` y `seguimiento_visita`
-- (043) nacieron después, y nacieron abiertas: el linter de Supabase las ha
-- señalado, con razón.
--
-- Lo que estaba expuesto no era poca cosa. `rastro` es por dónde ha andado
-- cada taxi minuto a minuto durante noventa días. `seguimiento_visita` son los
-- teléfonos de quién ha seguido el viaje de quién. Con la clave anónima del
-- proyecto y sin pasar por el servidor.
--
-- El fallo de fondo no es haber olvidado tres tablas: es que la 039 fue una
-- pasada única y esto necesita ser una regla permanente. La regla vive ahora
-- en una prueba (`servidor.prueba.ts`), que falla nombrando cualquier tabla
-- que se dé de alta sin RLS. Es el único sitio donde una regla así se cumple
-- sola: nadie se acuerda de un comentario, pero la batería no pasa.

ALTER TABLE rastro ENABLE ROW LEVEL SECURITY;
ALTER TABLE seguimiento ENABLE ROW LEVEL SECURITY;
ALTER TABLE seguimiento_visita ENABLE ROW LEVEL SECURITY;
