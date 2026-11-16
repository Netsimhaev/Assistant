-- 071_owner_links.sql
--
-- One-time links a technician issues to an owner: an invite (creates the
-- business's dashboard owner) or a password reset. The link carries a random
-- 32-byte token; only its sha256 is stored here, so a leaked backup of this
-- table is not a list of working links.
--
-- * `login` is the address the link was issued for, normalised. The redeemer
--   must type it again; a mismatch does not consume the link.
-- * `used_at` is set once, by a conditional UPDATE, and never cleared. A
--   newer link of the same kind for the same login marks the older unused
--   ones used.
-- * `issued_by` is the staff member's id, never their name.
--
-- Migration 068 does not cover tables added after it, so RLS is enabled here.

CREATE TABLE owner_links (
    business_id text        NOT NULL,
    link_hash   text        NOT NULL CHECK (link_hash ~ '^[0-9a-f]{64}$'),
    kind        text        NOT NULL CHECK (kind IN ('invite', 'password_reset')),
    login       text        NOT NULL CHECK (length(login) > 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    issued_by   text        NOT NULL,
    PRIMARY KEY (business_id, link_hash)
);

CREATE INDEX owner_links_login ON owner_links (business_id, kind, login);

ALTER TABLE owner_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON owner_links
    USING (business_id = app_business_id())
    WITH CHECK (business_id = app_business_id());
