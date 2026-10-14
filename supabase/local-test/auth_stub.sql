-- Stub mínimo de Supabase para aplicar las migraciones en un Postgres común
-- (pruebas del indexador). En Supabase real este esquema ya existe.
create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
