-- Resumption state: the plan a job is executing, and the steps of it that are
-- already done.
--
-- Until now a deferred job — quiet hours, a retryable adapter failure, an
-- approval to wait for — was parked with a wake time and nothing else. Neither
-- the plan nor the progress through it was written anywhere, so the scheduler
-- returned the job to `execute` and the runner started again from step one. A
-- first step that had already sent a mail sent it again.

-- The plan a job is executing, stored once.
--
-- One row per job, keyed by the job itself rather than by (job, hash): a job
-- has exactly one plan for its whole life. A second, different plan arriving
-- for the same job is refused by `bindPlanToJob` rather than stored alongside
-- the first — re-planning after partial execution means the world moved under
-- steps that already happened, and no automatic merge of the two is correct.
--
-- `plan` is kept beside the hash even though nothing reads it back today. The
-- hash alone can say "this is a different plan"; it cannot say what the job
-- was actually doing when someone reads the trail afterwards.
CREATE TABLE job_plans (
    business_id  TEXT        NOT NULL,
    job_id       TEXT        NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
    -- canonicalHash(plan) — see src/util/canonical.ts.
    plan_hash    TEXT        NOT NULL,
    plan         JSONB       NOT NULL,
    stored_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (business_id, job_id)
);

-- One row per step that finished. The presence of a row is the only thing that
-- lets a resumed run skip a step.
--
-- `plan_hash` is part of the key and is load-bearing, not bookkeeping. A
-- completion belongs to the plan it was produced under; results from one plan
-- must never let a different plan skip a step that happens to share an id.
-- `bindPlanToJob` refuses a changed plan up front, and this column is the
-- second, independent barrier behind that refusal.
--
-- `external_id` is the provider's handle on what the step created — a message
-- id, an order number. It survives the deferral so that `verify` can still ask
-- the far end what actually happened after a resume.
CREATE TABLE job_step_results (
    business_id  TEXT        NOT NULL,
    job_id       TEXT        NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
    plan_hash    TEXT        NOT NULL,
    step_id      TEXT        NOT NULL,
    external_id  TEXT,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (business_id, job_id, plan_hash, step_id)
);
