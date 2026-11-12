-- Multi-tenant stage A: one dashboard for every business (spec §5.5).
--
-- The login is an email address, unique across the whole server, and it is
-- what decides which business a user belongs to: the login form sends the
-- address alone, and `resolveLogin` (src/tenancy/platform.ts) finds the one
-- business that holds it. The old key `(business_id, username)` allowed two
-- "owner" rows in two businesses, which a server-wide form could not tell
-- apart. `username` stays — sessions, recovery codes and the audit trail
-- still name the account by it inside its business.
--
-- Backfill `login = username` so an existing install keeps a row that
-- satisfies NOT NULL; the operator replaces it with a real address when the
-- install moves to the shared server (§5.11). Uniqueness is on lower(login):
-- `Dana@x.example` and `dana@x.example` are one mailbox, and a second
-- business must not be able to claim it in another case.
ALTER TABLE dashboard_users ADD COLUMN login TEXT;
UPDATE dashboard_users SET login = username;
ALTER TABLE dashboard_users ALTER COLUMN login SET NOT NULL;
CREATE UNIQUE INDEX dashboard_users_login_unique ON dashboard_users (lower(login));

-- The unknown-login throttle (migration 010) becomes ONE row for the server.
-- Before a login has resolved there is no business to file a failure under,
-- so the bucket cannot be per business. Every reason 010 gives for one shared
-- row still holds, one level up: bounded (a random address does not make a
-- row), and it cannot lock a real account, whose failures go to its own
-- dashboard_users row.
--
-- Collapsed to the one row with the most failures, so a bucket that was
-- locked on some business before the migration stays locked. The counters
-- are transient; losing the others costs nothing.
DELETE FROM dashboard_unknown_user_throttle
 WHERE ctid NOT IN (
   SELECT ctid FROM dashboard_unknown_user_throttle
    ORDER BY failed_attempts + recovery_failed_attempts DESC
    LIMIT 1
 );
ALTER TABLE dashboard_unknown_user_throttle DROP CONSTRAINT dashboard_unknown_user_throttle_pkey;
ALTER TABLE dashboard_unknown_user_throttle DROP COLUMN business_id;
-- A one-row table: the key can only ever be `true`.
ALTER TABLE dashboard_unknown_user_throttle
  ADD COLUMN singleton BOOLEAN NOT NULL DEFAULT true CHECK (singleton);
ALTER TABLE dashboard_unknown_user_throttle ADD PRIMARY KEY (singleton);
