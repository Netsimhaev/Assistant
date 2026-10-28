-- 048_instruction_confirmations.sql
--
-- Boss command (spec 2026-10-28, §4.4, §10.2, §10.14). When the owner's
-- instruction has a side effect, the job is held and ONE confirmation question
-- is asked. Two tables, and deliberately not one.
--
-- `instruction_confirmations`: one row per job — the question as it was
-- presented (`presented_text`, the full text, never truncated) and every plan
-- the owner could choose between (`options`: `{label, planHash, plan,
-- contactSource}` per entry). The move to `confirmed` is a single
-- `UPDATE ... WHERE state = 'pending'`, so a double "כן" or two racing
-- channels confirm once. Both `presented_text` and `options` hold content
-- about a person (addresses, names, the body to be sent), so the table is
-- wired into erasure in BOTH roles: a closure target by `job_id`, and a
-- discovery source of its own (`erasure-plan.ts`).
--
-- `confirmed_step_claims`: one row per step of a confirmed plan that the gate
-- let run. `INSERT ... ON CONFLICT DO NOTHING RETURNING` is the claim, so a
-- step runs at most once even across a crash between the adapter's return and
-- the completion row. It holds ids and a hash only — no content — so erasure
-- deletes it by `job_id` with the job and never searches it.
--
-- `job_id` is plain TEXT with no foreign key in both, matching
-- `autonomy_marks` (026) and `action_updates` (047): a job is scrubbed, never
-- deleted, so a cascade would never fire.
CREATE TABLE instruction_confirmations (
    business_id      TEXT        NOT NULL,
    job_id           TEXT        NOT NULL,
    options          JSONB       NOT NULL,
    presented_text   TEXT        NOT NULL,
    presented_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    channel          TEXT        NOT NULL,
    state            TEXT        NOT NULL DEFAULT 'pending',
    chosen_plan_hash TEXT,
    decided_at       TIMESTAMPTZ,
    decided_by       TEXT,
    reask_of         TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One row per job. Scoped by business like every other key here
    -- (`action_updates_one_per_step`): job ids are unique in practice, and a
    -- key that spans businesses would let one business's row block another's.
    CONSTRAINT instruction_confirmations_one_per_job UNIQUE (business_id, job_id),
    CONSTRAINT instruction_confirmations_channel_known
      CHECK (channel IN ('whatsapp', 'dashboard')),
    CONSTRAINT instruction_confirmations_state_known
      CHECK (state IN ('pending', 'confirmed', 'cancelled', 'expired')),
    -- A chosen plan exists exactly when the row is confirmed: a confirmed row
    -- with no hash would let the gate exemption match nothing (or anything),
    -- and a cancelled row carrying one would look like an approval.
    CONSTRAINT instruction_confirmations_chosen_iff_confirmed
      CHECK ((state = 'confirmed') = (chosen_plan_hash IS NOT NULL))
);

-- The expiry sweep reads pending rows of one business by age.
CREATE INDEX instruction_confirmations_pending_idx
  ON instruction_confirmations (business_id, presented_at)
  WHERE state = 'pending';

CREATE TABLE confirmed_step_claims (
    business_id TEXT        NOT NULL,
    job_id      TEXT        NOT NULL,
    step_id     TEXT        NOT NULL,
    plan_hash   TEXT        NOT NULL,
    claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT confirmed_step_claims_once UNIQUE (business_id, job_id, step_id)
);
