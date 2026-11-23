-- 083_whatsapp_contacts.sql
--
-- WhatsApp for clients and suppliers, phase 1: conversations with contacts,
-- the owner's verdicts on proposed replies, documents assigned to a contact,
-- and the accounting-lookup configuration. Every table is per business with
-- RLS FORCE, like all tenant tables.

ALTER TABLE whatsapp_messages DROP CONSTRAINT whatsapp_messages_sender_kind_check;
ALTER TABLE whatsapp_messages ADD CONSTRAINT whatsapp_messages_sender_kind_check
    CHECK (sender_kind IN ('principal', 'other', 'contact', 'colleague', 'unknown'));
-- Outbound to a contact; NULL = to the owner.
ALTER TABLE whatsapp_messages ADD COLUMN recipient_number text;

CREATE TABLE contact_conversations (
    business_id        text        NOT NULL,
    conversation_id    text        NOT NULL,
    contact_key        text        NOT NULL,
    contact_subject_key text,
    contact_kind       text        NOT NULL CHECK (contact_kind IN ('client', 'supplier', 'unknown')),
    state              text        NOT NULL CHECK (state IN ('open', 'carded', 'answered', 'closed', 'expired')),
    opened_at          timestamptz NOT NULL DEFAULT now(),
    last_inbound_at    timestamptz NOT NULL,
    holding_sent_at    timestamptz,
    holding_due_at     timestamptz,
    card_job_id        text,
    card_presented_at  timestamptz,
    reminder_sent_at   timestamptz,
    closed_at          timestamptz,
    PRIMARY KEY (business_id, conversation_id)
);
CREATE UNIQUE INDEX contact_conversations_live_per_number
    ON contact_conversations (business_id, contact_key)
    WHERE state IN ('open', 'carded');

CREATE TABLE contact_reply_decisions (
    business_id     text        NOT NULL,
    decision_id     text        NOT NULL,
    conversation_id text        NOT NULL,
    job_id          text        NOT NULL,
    approval_id     text        NOT NULL,
    verdict         text        CHECK (verdict IN ('right', 'wrong', 'not_counted')),
    wrong_reason    text,
    source_tiers    text[]      NOT NULL,
    decided_at      timestamptz NOT NULL,
    PRIMARY KEY (business_id, decision_id),
    UNIQUE (business_id, approval_id)
);

CREATE TABLE contact_documents (
    business_id text        NOT NULL,
    document_id text        NOT NULL,
    contact_key text        NOT NULL,
    kind        text        NOT NULL CHECK (kind IN ('invoice')),
    assigned_by text        NOT NULL CHECK (assigned_by IN ('owner_upload', 'sent_mail', 'accounting')),
    assigned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, document_id, contact_key)
);

CREATE TABLE contact_whatsapp_settings (
    business_id            text        PRIMARY KEY,
    invoice_system_id      text,
    invoice_operation      text,
    invoice_customer_param text,
    invoice_customer_field text,
    updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE business_runtime_settings ADD COLUMN contact_wa_reads_per_day integer;

ALTER TABLE contact_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_conversations
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());

ALTER TABLE contact_reply_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_reply_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_reply_decisions
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());

ALTER TABLE contact_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_documents
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());

ALTER TABLE contact_whatsapp_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_whatsapp_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_whatsapp_settings
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());
