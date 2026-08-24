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

-- `false` on a freshly created row is a recorded observation: the job has not
-- read anything yet, and every future read runs through `markContentIngested`
-- before it happens. `false` on a row that already existed when this column
-- was added is not that. Nothing tracked whether those jobs read external
-- content, because the column did not exist yet to track it in — `false` here
-- would be the absence of an observation wearing the shape of one.
--
-- A value we could not read is never treated as the permissive one elsewhere
-- in this codebase (an unreadable amount becomes `amount_unreadable`, not
-- zero; an unrecognised data class counts as the most severe). The same rule
-- applies here: backfill every job still capable of taking another step to
-- `true`, so the first-contact exemption is withheld from history we cannot
-- vouch for rather than granted on the strength of a fact nobody captured.
--
-- Scoped to open jobs on purpose. A closed job (`closed_at IS NOT NULL`) will
-- never run another step, so its flag has no consumer left to mislead — and
-- marking it would only add noise to the audit picture for no safety benefit.
UPDATE jobs SET content_ingested = true WHERE closed_at IS NULL;
