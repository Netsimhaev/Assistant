-- Phase 0 spine: charter (L0), audit chain (L2), tasks/approvals (L5),
-- kill switch and the spend ledger.
--
-- L1 (entities), L3 (documents + embeddings) and L4 (learned preferences) land
-- with the memory service in Phase 1; L3 additionally needs pgvector, which is
-- not installed yet.

-- ---------------------------------------------------------------------------
-- L0 — Charter. Append-only: an amendment is a new row, never an UPDATE.

CREATE TABLE charter_versions (
    charter_version   TEXT PRIMARY KEY,
    business_id       TEXT        NOT NULL,
    effective_from    TIMESTAMPTZ NOT NULL,
    supersedes        TEXT        REFERENCES charter_versions (charter_version),
    -- The full signed charter document.
    charter           JSONB       NOT NULL,
    -- The compiled PolicyBundle the hooks evaluate.
    policy_bundle     JSONB       NOT NULL,
    -- sha256 over the canonical charter JSON excluding the signature block.
    content_hash      TEXT        NOT NULL,
    signed_by         TEXT        NOT NULL,
    signed_at         TIMESTAMPTZ NOT NULL,
    signature_method  TEXT        NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT charter_content_hash_is_sha256
        CHECK (content_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX charter_versions_business_effective_idx
    ON charter_versions (business_id, effective_from DESC);

-- Exactly one charter is active at a time. The pointer is a separate row so
-- activation is a single atomic UPDATE rather than a scan for "latest".
CREATE TABLE charter_active (
    business_id      TEXT PRIMARY KEY,
    charter_version  TEXT NOT NULL REFERENCES charter_versions (charter_version),
    activated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- L2 — Audit. Append-only and hash-chained. This is both the episodic memory
-- and the compliance record.

CREATE TABLE audit_log (
    seq             BIGSERIAL PRIMARY KEY,
    business_id     TEXT        NOT NULL,
    at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    job_id          TEXT,
    envelope_id     TEXT,
    actor           TEXT        NOT NULL,
    on_behalf_of    TEXT,
    kind            TEXT        NOT NULL,
    action_class    TEXT,
    charter_version TEXT        NOT NULL,
    provenance      TEXT        NOT NULL,
    risk            JSONB,
    input_hash      TEXT        NOT NULL,
    output_hash     TEXT,
    artifacts       JSONB       NOT NULL DEFAULT '[]'::jsonb,
    cost_minor      BIGINT,
    tokens          JSONB,
    reason          TEXT        NOT NULL,
    prev_hash       TEXT        NOT NULL,
    hash            TEXT        NOT NULL,

    CONSTRAINT audit_hash_is_sha256      CHECK (hash      ~ '^[0-9a-f]{64}$'),
    CONSTRAINT audit_prev_hash_is_sha256 CHECK (prev_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX audit_log_business_seq_idx    ON audit_log (business_id, seq DESC);
CREATE INDEX audit_log_job_idx             ON audit_log (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX audit_log_kind_idx            ON audit_log (business_id, kind, seq DESC);
CREATE INDEX audit_log_action_class_idx    ON audit_log (business_id, action_class, seq DESC)
    WHERE action_class IS NOT NULL;

-- The chain is append-only. Enforced in the database rather than by convention,
-- because "nobody would do that" is not a property you can audit.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only: % on seq % rejected', TG_OP, OLD.seq;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- ---------------------------------------------------------------------------
-- Kill switch. Three levels, all surviving a process restart because the state
-- lives here and is checked at the top of every gate and before every dequeue.

CREATE TABLE kill_switch (
    business_id  TEXT        NOT NULL,
    -- 'all' | 'outbound' | a department name ('front_office', 'operations', ...)
    scope        TEXT        NOT NULL,
    tripped      BOOLEAN     NOT NULL DEFAULT false,
    tripped_by   TEXT,
    tripped_at   TIMESTAMPTZ,
    reason       TEXT,
    released_by  TEXT,
    released_at  TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (business_id, scope)
);

-- ---------------------------------------------------------------------------
-- L5 — Jobs. The orchestrator's durable state machine. Phase 0 creates the
-- table; the orchestrator fills in the transitions.

CREATE TABLE jobs (
    job_id           TEXT PRIMARY KEY,
    business_id      TEXT        NOT NULL,
    phase            TEXT        NOT NULL,
    charter_version  TEXT        NOT NULL REFERENCES charter_versions (charter_version),
    -- Lowest trust in the causal chain. Stamped by the gateway before any model
    -- sees the content; no prompt can change it.
    provenance       TEXT        NOT NULL,
    title            TEXT,
    wake_at          TIMESTAMPTZ,
    token_budget     BIGINT      NOT NULL DEFAULT 0,
    tokens_spent     BIGINT      NOT NULL DEFAULT 0,
    money_ceiling_minor BIGINT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at        TIMESTAMPTZ
);

CREATE INDEX jobs_wake_idx  ON jobs (wake_at) WHERE wake_at IS NOT NULL AND closed_at IS NULL;
CREATE INDEX jobs_phase_idx ON jobs (business_id, phase) WHERE closed_at IS NULL;

CREATE TABLE job_steps (
    id           BIGSERIAL PRIMARY KEY,
    job_id       TEXT        NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
    from_phase   TEXT        NOT NULL,
    to_phase     TEXT        NOT NULL,
    at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor        TEXT        NOT NULL,
    envelope_id  TEXT,
    cost_minor   BIGINT,
    reason       TEXT        NOT NULL
);

CREATE INDEX job_steps_job_idx ON job_steps (job_id, at);

-- ---------------------------------------------------------------------------
-- L5 — Approvals.

CREATE TABLE approval_requests (
    approval_id     TEXT PRIMARY KEY,
    business_id     TEXT        NOT NULL,
    job_id          TEXT,
    envelope_id     TEXT,
    action_class    TEXT        NOT NULL,
    summary         TEXT        NOT NULL,
    detail          TEXT        NOT NULL,
    diff_vs_norm    TEXT,
    artifacts       JSONB       NOT NULL DEFAULT '[]'::jsonb,
    risk            JSONB       NOT NULL,
    proposed_tool   TEXT        NOT NULL,
    proposed_input  JSONB       NOT NULL,
    -- TOCTOU guard: the approval binds to the exact input it approved.
    input_hash      TEXT        NOT NULL,
    requested_from  JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    on_timeout      TEXT        NOT NULL DEFAULT 'escalate_next',
    state           TEXT        NOT NULL DEFAULT 'pending',

    decided_by      TEXT,
    decided_at      TIMESTAMPTZ,
    decided_channel TEXT,
    decision_note   TEXT,
    edited_input    JSONB,
    -- Hash of the input at the moment of decision. Compared against the live
    -- input before execution; a mismatch re-queues rather than proceeding.
    input_hash_at_decision TEXT,

    CONSTRAINT approval_state_known CHECK (
        state IN ('pending', 'approved', 'approved_with_edit', 'denied', 'expired', 'cancelled')
    ),
    CONSTRAINT approval_decision_is_complete CHECK (
        (state = 'pending')
        OR (state IN ('expired', 'cancelled'))
        OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND input_hash_at_decision IS NOT NULL)
    )
);

CREATE INDEX approval_pending_idx ON approval_requests (business_id, created_at)
    WHERE state = 'pending';
CREATE INDEX approval_expiry_idx  ON approval_requests (expires_at)
    WHERE state = 'pending';
CREATE INDEX approval_job_idx     ON approval_requests (job_id) WHERE job_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Spend ledger. Backs the daily and monthly ceilings. One row per committed
-- money action; the guard sums over a window rather than keeping a counter,
-- so a crash can never leave the running total wrong.

CREATE TABLE spend_ledger (
    id            BIGSERIAL PRIMARY KEY,
    business_id   TEXT        NOT NULL,
    job_id        TEXT,
    action_class  TEXT        NOT NULL,
    amount_minor  BIGINT      NOT NULL CHECK (amount_minor >= 0),
    currency      TEXT        NOT NULL,
    at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    audit_seq     BIGINT      REFERENCES audit_log (seq),
    -- Derived from (jobId, stepId, canonicalInputHash). Unique so a retry after
    -- an uncertain timeout cannot double-count spend.
    idempotency_key TEXT      NOT NULL,

    CONSTRAINT spend_idempotency_unique UNIQUE (business_id, idempotency_key)
);

CREATE INDEX spend_ledger_window_idx ON spend_ledger (business_id, at DESC);

-- ---------------------------------------------------------------------------
-- Autonomy ramp. Autonomy is earned per action class by measured agreement.

CREATE TABLE autonomy_ramp (
    business_id            TEXT NOT NULL,
    action_class           TEXT NOT NULL,
    level                  TEXT NOT NULL DEFAULT 'draft_only',
    samples                INTEGER NOT NULL DEFAULT 0,
    approved_without_edit  INTEGER NOT NULL DEFAULT 0,
    incidents              INTEGER NOT NULL DEFAULT 0,
    promoted_at            TIMESTAMPTZ,
    demoted_at             TIMESTAMPTZ,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (business_id, action_class)
);
