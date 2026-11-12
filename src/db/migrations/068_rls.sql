-- Multi-tenant stage A, the last step: close the wall (spec §5.6, §5.11).
--
-- Every base table in `public` with a `business_id` column gets row level
-- security, FORCEd (so a change of ownership, or a query that somehow runs as
-- the owner, is still filtered), and one policy that reads the business from
-- `app_business_id()` — never `current_setting()` directly, which returns ''
-- on a connection that was set and then RESET, and would read zero rows
-- silently instead of raising (migration 062).
--
-- The tables are found here, not listed: a table this migration did not know
-- about is still covered. A table added by a LATER migration is not — that
-- migration must enable RLS and create the policy itself, and
-- `src/tenancy/rls.test.ts` fails by the table's name if it does not.
--
-- Foreign-key checks and cascades run as the table owner and are not
-- filtered, so a child row still finds its parent and a delete still reaches
-- its children. The platform login is BYPASSRLS and reads every business
-- (spec §5.7); the migrator is the owner and a superuser in tests.

DO $$
DECLARE
    t text;
BEGIN
    FOR t IN
        SELECT DISTINCT c.table_name
          FROM information_schema.columns c
          JOIN information_schema.tables tb
            ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
         WHERE c.table_schema = 'public'
           AND c.column_name = 'business_id'
           AND tb.table_type = 'BASE TABLE'
           AND c.table_name NOT IN ('businesses', 'schema_migrations', 'platform_credentials',
                                    'server_key_state', 'dashboard_unknown_user_throttle')
         ORDER BY 1
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON public.%I '
            'USING (business_id = app_business_id()) '
            'WITH CHECK (business_id = app_business_id())',
            t);
    END LOOP;
END
$$;

-- The tables that belong to the server, not to a business. They carry no
-- business policy, so the GRANTs are the whole control: `assistant_app` keeps
-- only what a business connection (or `withNoBusiness`, before a login has
-- resolved) provably does with them.
--
--   businesses             — nothing. The registry is read and written only on
--                            the platform pool (`tenancy/platform.ts`,
--                            `tenancy/businesses.ts`; the dashboard's
--                            `getBusiness` too).
--   schema_migrations      — nothing. The migrator's own bookkeeping.
--   platform_credentials   — nothing. The server's OAuth client secrets,
--                            platform pool only (`tenancy/platform-credentials.ts`).
--   server_key_state       — SELECT. A business connection reads the server's
--                            key state to check the key and to name the live
--                            key id when it seals a row (`verifyKeyState`,
--                            `liveKeyId`: putSecret, writeGrant, recordRefresh,
--                            the dashboard's key check). Only the key CLI
--                            writes it, on the platform pool. A grant is per
--                            role, not per connection, so a `withNoBusiness`
--                            connection can read this row too — the throttle
--                            is not the only table it reaches. What it reads
--                            is the key id and the key check's ciphertext,
--                            never a secret.
--   dashboard_unknown_user_throttle — SELECT, INSERT, UPDATE. The one
--                            server-wide row `withNoBusiness` reads, clears
--                            and upserts before a login has resolved
--                            (`dashboard/unknown-user-throttle.ts`); the upsert
--                            needs INSERT and UPDATE both.
REVOKE ALL ON businesses, schema_migrations, platform_credentials,
              server_key_state, dashboard_unknown_user_throttle
  FROM assistant_app;
GRANT SELECT ON server_key_state TO assistant_app;
GRANT SELECT, INSERT, UPDATE ON dashboard_unknown_user_throttle TO assistant_app;

-- The platform login took its table privileges through `assistant_app`
-- (roles.ts: BYPASSRLS skips policies, not GRANTs). The revoke above takes the
-- server's tables from it too, so they come back through a group of its own,
-- which the app login must never belong to (`db:roles` refuses that).
-- Created here as well as by `db:roles`, NOLOGIN, for the same reason 062
-- creates `assistant_app`: a migrate on a cluster where db:roles has not run
-- yet must not fail on the GRANTs below. Roles are cluster-wide; a concurrent
-- creation on another database is tolerated.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant_platform_group') THEN
    CREATE ROLE assistant_platform_group NOLOGIN NOBYPASSRLS;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

--   businesses           — SELECT, INSERT, UPDATE: list, resolve a login,
--                          create, suspend (`tenancy/businesses.ts`). No delete.
--   platform_credentials — SELECT, INSERT, UPDATE, DELETE: `secret --platform`
--                          put/get/delete/list, and `rotate` re-seals them.
--   server_key_state     — SELECT, INSERT, UPDATE: `writeKeyState` upserts the
--                          one row; `rotate` and `create` read it.
GRANT SELECT, INSERT, UPDATE ON businesses TO assistant_platform_group;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_credentials TO assistant_platform_group;
GRANT SELECT, INSERT, UPDATE ON server_key_state TO assistant_platform_group;

-- An existing platform login (`db:roles` ran before this migration) joins the
-- group here, so the server keeps working between the migrate and the next
-- `db:roles`. Found by the one property that makes it the platform login: a
-- BYPASSRLS login in `assistant_app`. The app login is NOBYPASSRLS by
-- construction (roles.ts) and is never picked; a BYPASSRLS login already
-- reads every row, so the group gives it nothing the policies withheld.
DO $$
DECLARE
    r text;
BEGIN
    FOR r IN
        SELECT m.rolname
          FROM pg_auth_members am
          JOIN pg_roles g ON g.oid = am.roleid
          JOIN pg_roles m ON m.oid = am.member
         WHERE g.rolname = 'assistant_app'
           AND m.rolcanlogin
           AND m.rolbypassrls
    LOOP
        EXECUTE format('GRANT assistant_platform_group TO %I', r);
    END LOOP;
END
$$;
