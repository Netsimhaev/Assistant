-- 069_business_descriptions.sql
--
-- The owner's free-text description of the business (Stage C), versioned, and
-- the sentences the owner turned down when the assistant proposed rules from
-- it.
--
-- No erasure wiring, on purpose: the description is the owner's own text about
-- his own business, not content about a counterparty. Erasure shows a notice
-- instead (Task 7). The rejections hold hashes only.
--
-- Migration 068 does not cover tables added after it, so RLS is enabled here.

CREATE TABLE business_descriptions (
    business_id text        NOT NULL,
    version     integer     NOT NULL,
    text        text        NOT NULL CHECK (length(text) <= 8000),
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  text        NOT NULL,
    PRIMARY KEY (business_id, version)
);

CREATE TABLE description_rule_rejections (
    business_id   text        NOT NULL,
    sentence_hash text        NOT NULL CHECK (sentence_hash ~ '^[0-9a-f]{64}$'),
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, sentence_hash)
);

ALTER TABLE business_descriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_descriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_descriptions
    USING (business_id = app_business_id())
    WITH CHECK (business_id = app_business_id());

ALTER TABLE description_rule_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE description_rule_rejections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON description_rule_rejections
    USING (business_id = app_business_id())
    WITH CHECK (business_id = app_business_id());

-- Append-only for the runtime account: a version is history.
REVOKE UPDATE, DELETE ON business_descriptions FROM assistant_app;
