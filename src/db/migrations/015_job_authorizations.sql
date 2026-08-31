-- What the owner authorised when they opened a job
-- (docs/superpowers/specs/2026-08-31-proposal-planner-design.md §6).
--
-- An assistant that asks permission for the thing it was just told to do is an
-- assistant that annoys instead of helping. A row here says: for THIS job, the
-- owner already named this action class and these recipients, so the gate does
-- not ask a second time.
--
-- This is not a way around the gate. All ten stages still run — kill switch,
-- charter ceilings, quiet hours, budget, risk, audit. One stage changes:
-- needsApproval is satisfied by the instruction on record instead of by a
-- fresh question.
--
-- THE RULE THIS TABLE EXISTS TO HOLD: a row is written only from a path the
-- owner actually drove. Nothing derived from a document, a Reading, a Proposal,
-- or any model output may write here. A document whose body claims the owner
-- asked for something is content, not a stamp — and the difference between
-- those two is the whole prompt-injection defence.
CREATE TABLE job_authorizations (
    business_id  TEXT        NOT NULL,
    job_id       TEXT        NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
    -- The action class the owner named. A different class asks.
    action_class TEXT        NOT NULL,
    -- The addresses the owner named, lower-cased. An action whose recipients
    -- are not a subset of these asks. Empty means the owner named no
    -- recipient, which covers only internal actions.
    recipients   TEXT[]      NOT NULL DEFAULT '{}',
    granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One authorisation per job. An owner who wants a second action authorised
    -- opens a second job; widening an existing grant in place would leave no
    -- record of what was originally asked for.
    PRIMARY KEY (business_id, job_id)
);
