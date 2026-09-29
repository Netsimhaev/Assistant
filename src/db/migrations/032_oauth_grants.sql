-- One encrypted OAuth grant per (business, system). The refresh token never
-- appears in any other column. Sealed under the same master key as
-- `credentials`, but with AAD `grant:<system>` -- a string a real secret ref
-- can never equal, because `credentials.ref` is constrained to
-- ^[A-Z0-9_]+$. That is what makes a grant and a secret structurally
-- unopenable as one another, with no blocklist to maintain.
CREATE TABLE oauth_grants (
    business_id       TEXT NOT NULL,
    system            TEXT NOT NULL,
    provider          TEXT NOT NULL,
    -- The ref the binding names. This is how the row is FOUND (spec 3.1a):
    -- performStep resolves by ref, so the grant answers to the same ref.
    credential_ref    TEXT NOT NULL,
    account           TEXT NOT NULL,
    scopes            TEXT[] NOT NULL,
    ciphertext        BYTEA NOT NULL,
    nonce             BYTEA NOT NULL,
    key_id            TEXT NOT NULL,
    granted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by        TEXT NOT NULL,
    last_refreshed_at TIMESTAMPTZ,
    refresh_count     INTEGER NOT NULL DEFAULT 0,
    -- Soft, like a retired memory: a business needs to know access EXISTED.
    revoked_at        TIMESTAMPTZ,
    -- Set when the provider refuses the refresh token: the owner must consent
    -- again. Distinct from `revoked_at`, which is the owner's own act.
    needs_reauth_at   TIMESTAMPTZ,
    PRIMARY KEY (business_id, system),
    CONSTRAINT oauth_grants_ref_shape CHECK (credential_ref ~ '^[A-Z0-9_]+$')
);

-- The lookup performStep drives. Unique per business so a ref cannot address
-- two grants; a ref shared with a static secret is refused in code, not here,
-- because the two live in different tables.
CREATE UNIQUE INDEX oauth_grants_by_ref ON oauth_grants (business_id, credential_ref);
