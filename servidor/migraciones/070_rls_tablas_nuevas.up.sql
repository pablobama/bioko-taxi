-- 070 — RLS en las tablas que llegaron con las migraciones 066 y 067.
--
-- Misma regla permanente de la 045, y otra vez la misma historia: una tabla
-- nace y nace abierta a la API pública de Supabase. `precio_declarado` es lo
-- que cada pasajero dice que pagó, y `cambio_ajuste` es el registro de quién
-- tocó los precios — justo el registro que no debe poder leer ni tocar quien
-- está siendo vigilado por él.
--
-- La prueba de `servidor.prueba.ts` fue la que las señaló, que es para lo que
-- está: nadie se acuerda de un comentario, pero la batería no pasa.

ALTER TABLE precio_declarado ENABLE ROW LEVEL SECURITY;
ALTER TABLE cambio_ajuste ENABLE ROW LEVEL SECURITY;
