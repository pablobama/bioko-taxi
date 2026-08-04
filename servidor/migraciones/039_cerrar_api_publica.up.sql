-- 039 — Cerrar la puerta de atrás: RLS en todas las tablas.
--
-- Supabase publica el esquema `public` por HTTP (PostgREST) sin que nadie lo
-- pida. Esta app no usa esa API para nada —el servidor habla Postgres
-- directo con `pg`, no hay una sola línea de cliente de Supabase en el
-- repositorio— pero la puerta estaba abierta igual: con la clave anónima del
-- proyecto se podía leer `conductor` (nombres y teléfonos), `posicion`
-- (dónde ha estado cada taxi, minuto a minuto), y `monedero` y `apunte` (el
-- dinero), sin pasar por el servidor ni dejar rastro en sus registros.
--
-- Activar RLS sin escribir ninguna política es exactamente lo que hace falta:
-- para quien entra por PostgREST (roles `anon` y `authenticated`) toda
-- consulta pasa a devolver cero filas, porque no hay política que permita
-- ninguna. El dueño de las tablas —el rol con el que conecta el servidor,
-- que es quien las creó en estas mismas migraciones— se la salta por
-- definición de Postgres, así que la app no se entera. Por eso NO se usa
-- FORCE ROW LEVEL SECURITY: eso sí alcanzaría al dueño y dejaría la app sin
-- base de datos.
--
-- Y por si acaso, la comprobación de abajo: si el rol que ejecuta esto no es
-- el dueño de las tablas ni las puede saltar, la migración FALLA y no aplica
-- nada. Un despliegue roto y ruidoso es infinitamente mejor que una app que
-- arranca y no ve ni un conductor.

DO $$
DECLARE
  ajenas text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO ajenas
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relowner <> current_user::text::regrole::oid;

  IF ajenas IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_roles
       WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
     )
  THEN
    RAISE EXCEPTION
      'No se activa RLS: % no son de «%», que se quedaría fuera de sus propias tablas.',
      ajenas, current_user;
  END IF;
END $$;

DO $$
DECLARE
  tabla record;
BEGIN
  FOR tabla IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tabla.relname);
  END LOOP;
END $$;

-- Una vista se ejecuta con los permisos de quien la creó, no de quien la
-- consulta: `saldo_monedero` seguiría enseñando el saldo de todos los
-- taxistas por PostgREST aunque `monedero` y `apunte` estén cerradas.
-- security_invoker la hace correr como quien pregunta, que es lo que
-- cualquiera espera al leerla.
ALTER VIEW saldo_monedero SET (security_invoker = true);
