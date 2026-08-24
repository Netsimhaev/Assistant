-- Whether this job has ever pulled content from outside the instance's trust
-- boundary. Monotonic: set to true before such a read is performed, and never
-- cleared.
--
-- It exists because `provenance` is stamped once on the job and inherited by
-- every step, so a job the boss opened still reads as `boss` after a step has
-- fetched an attacker-authored document. The first-contact exemption
-- (src/policy/risk.ts) must not fire for such a job, and the plan currently
-- bound is not enough to tell: a re-plan after the read produces a plan that
-- contains no reader at all.
--
-- Set BEFORE the read, not after. A crash between the read and the write would
-- otherwise leave a job that ingested content and does not remember it, which
-- is the one direction that hands out an exemption nobody earned.
ALTER TABLE jobs
    ADD COLUMN content_ingested BOOLEAN NOT NULL DEFAULT false;
