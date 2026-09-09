-- 022_boss_instructions.sql
--
-- What the owner typed, kept beside the job it opened.
--
-- A table rather than a column on `jobs`, for two reasons. `jobs.title` is a
-- display field and an instruction is a paragraph. And this row is the evidence
-- the standing authorisation was derived from — it has to be readable back
-- alongside the audit trail, not compressed into a label.
--
-- `job_id` is UNIQUE: one instruction opens one job, and a second instruction
-- is a second job. Without the constraint, "the instruction for this job"
-- would be a question with more than one answer.

CREATE TABLE boss_instructions (
    instruction_id TEXT        PRIMARY KEY,
    business_id    TEXT        NOT NULL,
    job_id         TEXT        NOT NULL UNIQUE REFERENCES jobs (job_id) ON DELETE CASCADE,
    -- Verbatim, as typed. Never reformatted: the recipient rule in
    -- `authorisedRecipients` matches against exactly these bytes.
    text           TEXT        NOT NULL,
    -- The owner's reply to a clarifying question, when one was asked.
    -- Stored beside the instruction and never in place of it, so the re-plan
    -- sees both and the audit trail shows what was asked and what was answered.
    answer         TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT boss_instructions_text_not_empty CHECK (length(btrim(text)) > 0),
    CONSTRAINT boss_instructions_text_bounded   CHECK (length(text) <= 4000)
);

CREATE INDEX boss_instructions_business_idx ON boss_instructions (business_id, created_at DESC);
