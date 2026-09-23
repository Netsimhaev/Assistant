-- One encrypted secret per (business, ref). The value never appears in any
-- other column, here or anywhere else in the schema.
CREATE TABLE credentials (
    business_id  TEXT NOT NULL,
    ref          TEXT NOT NULL,
    ciphertext   BYTEA NOT NULL,
    nonce        BYTEA NOT NULL,
    key_id       TEXT NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by   TEXT NOT NULL,
    PRIMARY KEY (business_id, ref),
    CONSTRAINT credentials_ref_shape CHECK (ref ~ '^[A-Z0-9_]+$')
);

-- Which key is live, and a value that proves a key file is the right one
-- BEFORE anything tries to decrypt a real secret (spec 5.1). One row.
CREATE TABLE credential_key_state (
    business_id  TEXT PRIMARY KEY,
    key_id       TEXT NOT NULL,
    check_nonce  BYTEA NOT NULL,
    check_value  BYTEA NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
