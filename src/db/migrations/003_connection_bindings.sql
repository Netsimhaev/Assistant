-- Whether a connection the charter permits currently works.
--
-- Deliberately has NO channel column. The charter is the only source of truth
-- for what is permitted and on which channel; this table cannot change either
-- one. Adding a channel here would create a second, unsigned place where
-- authority is decided.
--
-- It CAN change where a permitted connection points and which secret it uses
-- (endpoint, credential_ref) — that is not "narrow only", it is a real
-- expansion of what a signed connection does in practice. Those fields are
-- deliberately outside the charter (rotating a credential must not require
-- the owner's signature), so the mitigation lives elsewhere: every write that
-- changes ROUTING or CREDENTIALS (upsertBinding, in
-- src/orchestrator/bindings.ts) is audited, so a redirect is at least as
-- visible as a kill switch trip. last_ok_at/last_error are the one exception:
-- recordBindingOutcome (same file) writes only those two columns, on every
-- adapter call, and does not audit — a health-bookkeeping fact about whether
-- a call just landed is not a change in where trust is placed, and auditing
-- it at that volume would drown the routing/credential changes the trail
-- exists to make visible.
--
-- No foreign key to charter_versions: a connection survives a charter
-- replacement, and whether it matches a declared system is checked when the
-- channel is resolved rather than when the row is written.

CREATE TABLE connection_bindings (
    business_id     TEXT        NOT NULL,
    system          TEXT        NOT NULL,
    status          TEXT        NOT NULL,
    endpoint        TEXT,
    -- A POINTER to a secret. Never the secret itself.
    credential_ref  TEXT,
    last_ok_at      TIMESTAMPTZ,
    last_error      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (business_id, system),
    CONSTRAINT connection_status_known
        CHECK (status IN ('live', 'disconnected', 'error'))
);
