-- 086_contact_suggestions.sql
--
-- WhatsApp for clients and suppliers, phase 2 package 2 (learning): one row per
-- suggestion offered to the owner (a new topic, auto-reply on a topic, a
-- document to mark public). The shape hash makes a shape offerable once, in
-- any state — a rejected shape is never offered again.

CREATE TABLE contact_suggestions (
    business_id   text        NOT NULL,
    suggestion_id text        NOT NULL,
    kind          text        NOT NULL CHECK (kind IN ('new_topic', 'auto_reply', 'public_document')),
    payload       jsonb       NOT NULL,
    shape_hash    text        NOT NULL CHECK (shape_hash ~ '^[0-9a-f]{64}$'),
    state         text        NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'rejected', 'expired')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    delivered_at  timestamptz,
    decided_at    timestamptz,
    decided_by    text,
    PRIMARY KEY (business_id, suggestion_id),
    UNIQUE (business_id, shape_hash)
);

ALTER TABLE contact_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_suggestions
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());
