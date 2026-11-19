-- 078_external_scan_learning.sql
--
-- Stage D, Task 12: the daily scan and learning from external events.
--
-- external_system_state gains the last scan ATTEMPT and its outcome (a fixed
-- short code, never provider content). `last_scan_at` keeps its meaning — the
-- last SUCCESSFUL scan, which is what `sinceParam` and the `everyHours` clock
-- read — so a failed scan never moves the window it asks about.
--
-- external_events gains `curation_job_id`: the learning job that claimed the
-- event. The claim is what the curation brief reads its events by, and what
-- keeps two passes from curating the same event twice.
--
-- Both tables already carry RLS FORCE and the standard policy (077).

ALTER TABLE external_system_state
    ADD COLUMN last_scan_attempt_at timestamptz,
    ADD COLUMN last_scan_outcome    text;

ALTER TABLE external_events ADD COLUMN curation_job_id text;

CREATE INDEX external_events_uncurated
    ON external_events (business_id, system_id, created_at)
    WHERE curated_at IS NULL;
CREATE INDEX external_events_curation_job
    ON external_events (business_id, curation_job_id)
    WHERE curation_job_id IS NOT NULL;
