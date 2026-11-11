-- Multi-tenant stage A, step 1: the business context function and the grants
-- for the application role. NO row level security yet — that is the last
-- migration of the stage (spec §5.11 step 4), so the new code can run on the
-- app role before the wall closes.

-- The group role the grants go to. `npm run db:roles` (src/db/roles.ts)
-- creates it and the logins too; it is created here as well, NOLOGIN, so that
-- `npm run migrate` on a cluster where db:roles has not run yet does not fail
-- on the GRANTs below. Roles are cluster-wide; a concurrent creation on
-- another database is tolerated.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant_app') THEN
    CREATE ROLE assistant_app NOLOGIN NOBYPASSRLS;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

-- The business of the current session. Every RLS policy calls this, never
-- current_setting() directly: once a custom setting has been set on a
-- connection, RESET leaves it as '' rather than NULL, and current_setting()
-- returns '' without raising — a policy reading it would return zero rows
-- silently. A pooled connection has always been set before. So: NULL or ''
-- raises (spec §5.6).
CREATE FUNCTION app_business_id() RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v text := current_setting('app.business_id', true);
BEGIN
  IF v IS NULL OR v = '' THEN
    RAISE EXCEPTION 'no business context';
  END IF;
  RETURN v;
END
$$;

-- The app role owns nothing; it is granted DML on what the migrator owns.
GRANT USAGE ON SCHEMA public TO assistant_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO assistant_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO assistant_app;

-- And on whatever later migrations (run by the same migrator role) create.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO assistant_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO assistant_app;
