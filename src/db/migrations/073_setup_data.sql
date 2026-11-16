-- 073_setup_data.sql
--
-- What a technician prepares for a business before the owner's first
-- signature, and what the owner confirms out of it (admin-panel spec):
--
-- * `setup_packages` — one row per business: the boss's WhatsApp number, and
--   the contacts and colleagues the technician typed. Pre-confirmation data:
--   the panel writes it only while the business has no active charter, and it
--   is cleared once the owner has confirmed (or discarded) it. The row goes
--   when all three fields are empty.
-- * `business_profiles` — the business's own address and logo. The logo file
--   lives at `<DOCUMENT_ROOT>/<businessId>/profile/logo.png|jpg`; the path
--   here is relative to `DOCUMENT_ROOT`, and the sha256 is re-checked on every
--   read.
-- * `business_colleagues` — the confirmed colleagues. A colleague never gives
--   instructions; a message from a colleague's number is recorded and not
--   answered, like a stranger's.
--
-- Erasure: `business_colleagues` and `setup_packages` hold people and are
-- wired into contact erasure (`erasure-plan.ts`). `business_profiles` holds
-- the business's own address, not a counterparty, and is not.
--
-- Migration 068 does not cover tables added after it, so RLS is enabled here.

CREATE TABLE setup_packages (
    business_id   text        PRIMARY KEY,
    boss_whatsapp text,
    contacts      jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(contacts) = 'array'),
    colleagues    jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(colleagues) = 'array'),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    text        NOT NULL
);

CREATE TABLE business_profiles (
    business_id     text        PRIMARY KEY,
    address         text        CHECK (address IS NULL OR length(address) <= 300),
    logo_path       text,
    logo_media_type text        CHECK (logo_media_type IN ('image/png', 'image/jpeg')),
    logo_sha256     text        CHECK (logo_sha256 IS NULL OR logo_sha256 ~ '^[0-9a-f]{64}$'),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      text        NOT NULL,
    -- The three logo columns are set together or not at all.
    CHECK ((logo_path IS NULL) = (logo_media_type IS NULL) AND (logo_path IS NULL) = (logo_sha256 IS NULL))
);

CREATE TABLE business_colleagues (
    business_id  text        NOT NULL,
    colleague_id text        NOT NULL,
    name         text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    role         text        NOT NULL CHECK (length(role) BETWEEN 1 AND 120),
    phone        text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, colleague_id)
);

ALTER TABLE setup_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE setup_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON setup_packages
    USING (business_id = app_business_id())
    WITH CHECK (business_id = app_business_id());

ALTER TABLE business_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_profiles
    USING (business_id = app_business_id())
    WITH CHECK (business_id = app_business_id());

ALTER TABLE business_colleagues ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_colleagues FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_colleagues
    USING (business_id = app_business_id())
    WITH CHECK (business_id = app_business_id());
