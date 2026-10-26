-- 047_action_updates.sql
--
-- Shadow mode: the owner hears about every action the assistant performed on
-- her own. Two tables, and — exactly like 040's `digest_settings`/`digests` —
-- deliberately not one: `action_update_settings` is the owner's CHOICE (one
-- row per business), `action_updates` is the RECORD of what she was told.
--
-- The `at_least_one_channel` CHECK is the second layer behind
-- `saveActionUpdateSettings`'s own refusal: an update that goes nowhere is an
-- autonomous action the owner never hears about, which is the one outcome
-- this feature exists to prevent. The module refuses first, with a Hebrew
-- message; the database makes it impossible to WRITE regardless of who wrote
-- the INSERT.
CREATE TABLE action_update_settings (
    business_id  TEXT PRIMARY KEY,
    to_whatsapp  BOOLEAN     NOT NULL,
    to_email     BOOLEAN     NOT NULL,
    to_screen    BOOLEAN     NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by   TEXT        NOT NULL,
    CONSTRAINT action_update_settings_at_least_one_channel
      CHECK (to_whatsapp OR to_email OR to_screen)
);

-- One row per performed step. `job_id` is plain TEXT with no foreign key,
-- matching `autonomy_marks` (026): a job is scrubbed, never deleted, so a
-- cascade would never fire, and erasure reaches this table by `job_id`
-- membership the same way it reaches `autonomy_marks`.
--
-- `recipient`, `subject` and `body` are content about a counterparty and are
-- wired into erasure (`erasure-plan.ts`'s `countItems` and `erasure.ts`).
--
-- The two delivery columns are nullable on purpose, with 040's meaning: NULL
-- is "channel not chosen", which is a different fact from
-- 'skipped_not_connected' (chosen, and could not be reached). The screen
-- channel has no state column: `seen_at` NULL means "not seen yet".
--
-- UNIQUE on (business_id, job_id, step_id): a step that performed once is
-- reported once, however many scheduler passes look at it.
CREATE TABLE action_updates (
    update_id      TEXT PRIMARY KEY,
    business_id    TEXT        NOT NULL,
    job_id         TEXT        NOT NULL,
    step_id        TEXT        NOT NULL,
    action_class   TEXT        NOT NULL,
    recipient      TEXT,
    subject        TEXT,
    body           TEXT        NOT NULL,
    email_state    TEXT,
    whatsapp_state TEXT,
    seen_at        TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT action_updates_one_per_step UNIQUE (business_id, job_id, step_id),
    CONSTRAINT action_updates_email_state_known
      CHECK (email_state IS NULL OR email_state IN ('sent', 'failed', 'skipped_not_connected')),
    CONSTRAINT action_updates_whatsapp_state_known
      CHECK (whatsapp_state IS NULL OR whatsapp_state IN ('sent', 'failed', 'skipped_not_connected'))
);

-- The screen lists a business's updates newest first.
CREATE INDEX action_updates_business_created_idx
  ON action_updates (business_id, created_at DESC);
