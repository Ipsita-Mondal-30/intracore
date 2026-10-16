-- Stand-ins for Supabase-provided objects so prisma/migrations apply to plain
-- local Postgres (tests/dev only). Never run this against Supabase.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN CREATE PUBLICATION supabase_realtime; END IF;
END $$;
