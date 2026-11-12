-- Multi-tenant stage A, step 2: the registry of businesses on this server,
-- and a business_id on the two child tables that had none (so RLS can name it).
--
-- No foreign key from any data table to `businesses` — existence is enforced
-- where a business is chosen (scheduler list, login, CLIs), RLS is the wall.

CREATE TABLE businesses (
    business_id  TEXT PRIMARY KEY CHECK (business_id ~ '^[a-z0-9-]{3,63}$'),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    suspended_at TIMESTAMPTZ
);

-- Backfill from every place an install already holds a business. An id that
-- does not fit the format would be left out of the registry while its rows
-- stay behind row level security with no business to own them, so it refuses
-- the migration, naming the id, rather than being skipped (final review).
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(DISTINCT b, ', ') INTO bad
    FROM (SELECT business_id AS b FROM charter_versions
          UNION SELECT business_id FROM jobs
          UNION SELECT business_id FROM dashboard_users) found
   WHERE b !~ '^[a-z0-9-]{3,63}$';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 063: business id(s) not matching ^[a-z0-9-]{3,63}$: %', bad;
  END IF;
END $$;

INSERT INTO businesses (business_id, display_name)
SELECT b, b
  FROM (SELECT business_id AS b FROM charter_versions
        UNION SELECT business_id FROM jobs
        UNION SELECT business_id FROM dashboard_users) found
 WHERE b ~ '^[a-z0-9-]{3,63}$'
ON CONFLICT DO NOTHING;

ALTER TABLE job_steps ADD COLUMN business_id TEXT;
UPDATE job_steps s SET business_id = j.business_id FROM jobs j WHERE j.job_id = s.job_id;
ALTER TABLE job_steps ALTER COLUMN business_id SET NOT NULL;

ALTER TABLE document_versions ADD COLUMN business_id TEXT;
UPDATE document_versions v SET business_id = p.business_id
  FROM document_productions p WHERE p.production_id = v.production_id;
ALTER TABLE document_versions ALTER COLUMN business_id SET NOT NULL;
