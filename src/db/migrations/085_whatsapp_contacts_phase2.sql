-- 085_whatsapp_contacts_phase2.sql
--
-- WhatsApp for clients and suppliers, phase 2 package 1 (auto-reply): owner-
-- approved topics, per-message card context, send-time clearances, public
-- documents, and the extra settings columns. New tables are per business
-- with RLS FORCE.

CREATE TABLE contact_topics (
    business_id text        NOT NULL,
    topic_id    text        NOT NULL,
    name        text        NOT NULL,
    description text        NOT NULL DEFAULT '',
    applies_to  text        NOT NULL CHECK (applies_to IN ('client', 'supplier', 'both')),
    sources     text[]      NOT NULL,
    auto_reply  boolean     NOT NULL DEFAULT false,
    created_by  text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    retired_at  timestamptz,
    PRIMARY KEY (business_id, topic_id)
);

CREATE TABLE contact_card_context (
    business_id          text        NOT NULL,
    job_id               text        NOT NULL,
    kind                 text        NOT NULL CHECK (kind IN ('question', 'request', 'commitment', 'courtesy', 'unclassified')),
    topic_id             text,
    summary              text        NOT NULL CHECK (length(summary) <= 200),
    source_names         text[]      NOT NULL,
    internal_document_ids text[]     NOT NULL,
    auto                 boolean     NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, job_id)
);

CREATE TABLE contact_auto_clearances (
    business_id     text        NOT NULL,
    job_id          text        NOT NULL,
    step_id         text        NOT NULL,
    input_hash      text        NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    conversation_id text        NOT NULL,
    topic_id        text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, job_id, step_id)
);

ALTER TABLE documents ADD COLUMN public_for text CHECK (public_for IN ('client', 'supplier', 'both'));

ALTER TABLE contact_reply_decisions
    ADD COLUMN topic_id text,
    ADD COLUMN summary text,
    ADD COLUMN source_names text[],
    ADD COLUMN internal_document_ids text[];

ALTER TABLE contact_whatsapp_settings
    ADD COLUMN auto_reply_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN external_sources jsonb NOT NULL DEFAULT '[]';

ALTER TABLE contact_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_topics FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_topics
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());

ALTER TABLE contact_card_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_card_context FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_card_context
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());

ALTER TABLE contact_auto_clearances ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_auto_clearances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_auto_clearances
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());
