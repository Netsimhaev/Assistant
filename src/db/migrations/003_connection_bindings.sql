-- Whether a connection the charter permits currently works.
--
-- Deliberately has NO channel column. The charter is the only source of truth
-- for what is permitted and on which channel; this table can narrow a
-- permitted connection to unusable, and can do nothing else. Adding a channel
-- here would create a second, unsigned place where authority is decided.
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
