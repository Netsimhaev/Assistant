-- An approval a person granted is spendable exactly once.
--
-- Without `consumed_at`, a job that loops back to the same step spends one
-- approval repeatedly: a single "yes" on a purchase becomes several real
-- orders. The column is the whole of that defence, and the conditional UPDATE
-- in `consumeApproval` is what makes it race-free.
--
-- `consumed_by_step` is for the audit trail alone: it answers "which step
-- spent this?" when reading the chain back afterwards.
ALTER TABLE approval_requests
    ADD COLUMN consumed_at      TIMESTAMPTZ,
    ADD COLUMN consumed_by_step TEXT;

-- The dashboard's own account. Exactly one row per business in stage 0.
--
-- No self-registration and no emailed reset link: the mailbox is what the
-- assistant itself reads, so a mailbox compromise must not also hand over the
-- screen that authorises spending.
CREATE TABLE dashboard_users (
    business_id      TEXT        NOT NULL,
    username         TEXT        NOT NULL,
    password_hash    TEXT        NOT NULL,
    password_salt    TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at    TIMESTAMPTZ,
    failed_attempts  INTEGER     NOT NULL DEFAULT 0,
    locked_until     TIMESTAMPTZ,

    PRIMARY KEY (business_id, username)
);

CREATE TABLE dashboard_sessions (
    session_id   TEXT PRIMARY KEY,
    business_id  TEXT        NOT NULL,
    username     TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX dashboard_session_owner_idx
    ON dashboard_sessions (business_id, username)
 WHERE revoked_at IS NULL;

-- Single-use recovery codes. Hashed with a per-code salt exactly like a
-- password: the code itself is shown once at creation and is never stored,
-- so it cannot be read back out of the database by anyone.
CREATE TABLE dashboard_recovery_codes (
    code_id      TEXT PRIMARY KEY,
    business_id  TEXT        NOT NULL,
    username     TEXT        NOT NULL,
    code_hash    TEXT        NOT NULL,
    code_salt    TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    used_at      TIMESTAMPTZ
);

CREATE INDEX dashboard_recovery_unused_idx
    ON dashboard_recovery_codes (business_id, username)
 WHERE used_at IS NULL;
