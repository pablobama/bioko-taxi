-- Vuelve a abrir el esquema a PostgREST. Solo tiene sentido si algún día se
-- decide usar la API de Supabase de verdad, con políticas escritas.

ALTER VIEW saldo_monedero RESET (security_invoker);

DO $$
DECLARE
  tabla record;
BEGIN
  FOR tabla IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', tabla.relname);
  END LOOP;
END $$;
