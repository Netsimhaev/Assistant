-- 076_staff_cli_actor.sql
--
-- The server's command line becomes an actor in the staff tables (final
-- review I2). `npm run staff -- reset-factor | reissue-link` is the
-- break-glass for a team whose only head lost a phone or a password; no staff
-- member performed it, so naming one would put a false row in the log.
--
-- * platform_activity_log.staff_id — NULL means "the server command line".
-- * platform_staff_links.issued_by — NULL means the link was issued from the
--   server command line, not by a head in the panel.
--
-- Re-inviting a removed address reactivates the same row (`inviteStaff`), so
-- the unique index on lower(login) stays total: one address, one member,
-- one history in the activity log.

ALTER TABLE platform_activity_log ALTER COLUMN staff_id DROP NOT NULL;
ALTER TABLE platform_staff_links  ALTER COLUMN issued_by DROP NOT NULL;
