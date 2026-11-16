-- 075_business_profile_name.sql
--
-- The business's display name on its own profile row, where a business
-- connection can read it (admin-panel task 14: the name in official messages
-- and in the letterhead of produced documents).
--
-- Why a copy and not a read of `businesses`: migration 068 revokes every
-- privilege on `businesses` from `assistant_app`, and that table has no RLS —
-- a grant would let every business read every other business's name. The
-- drafters run on a business connection and must never take the platform
-- pool. `businesses.display_name` is written once, by `createBusiness`, which
-- now writes this column in the same statement; there is no rename path, so
-- the two cannot drift. Existing businesses are backfilled here.
--
-- The backfill runs as the table owner, and `business_profiles` FORCEs RLS
-- (073), so a plain INSERT would hit `app_business_id()` with no business set
-- and throw. FORCE is lifted for the backfill only, inside this migration's
-- transaction, and restored before it commits.

ALTER TABLE business_profiles
    ADD COLUMN display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 120);

ALTER TABLE business_profiles NO FORCE ROW LEVEL SECURITY;

INSERT INTO business_profiles (business_id, display_name, updated_by)
SELECT business_id, display_name, 'migration-075' FROM businesses
ON CONFLICT (business_id) DO UPDATE SET display_name = EXCLUDED.display_name;

ALTER TABLE business_profiles FORCE ROW LEVEL SECURITY;
