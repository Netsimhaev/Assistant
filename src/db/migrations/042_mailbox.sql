-- 042_mailbox.sql
--
-- Mailbox connection (Gmail / Microsoft 365): the poll cursor, the mail we
-- read, and the invoices we extracted from it.
--
-- `mail_messages.body_text` is nullable on purpose: bodies are scrubbed after
-- the retention window (`body_scrubbed_at`) while metadata, summary and
-- invoices remain.

CREATE TABLE mailbox_cursor (
    business_id   TEXT PRIMARY KEY,
    provider      TEXT        NOT NULL,
    cursor        TEXT        NOT NULL,
    connected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_poll_at  TIMESTAMPTZ,
    last_error    TEXT,
    CONSTRAINT mailbox_cursor_provider_known CHECK (provider IN ('google', 'microsoft'))
);

CREATE TABLE mail_messages (
    mail_id             TEXT PRIMARY KEY,
    business_id         TEXT        NOT NULL,
    provider_message_id TEXT        NOT NULL,
    thread_id           TEXT        NOT NULL,
    internet_message_id TEXT,
    references_header   TEXT,
    from_address        TEXT        NOT NULL,
    from_name           TEXT,
    reply_to            TEXT,
    to_addresses        TEXT[]      NOT NULL DEFAULT '{}',
    subject             TEXT        NOT NULL,
    received_at         TIMESTAMPTZ NOT NULL,
    body_text           TEXT,
    body_truncated      BOOLEAN     NOT NULL DEFAULT false,
    body_scrubbed_at    TIMESTAMPTZ,
    header_flags        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    attachments         JSONB       NOT NULL DEFAULT '[]'::jsonb,
    state               TEXT        NOT NULL DEFAULT 'received',
    categories          TEXT[]      NOT NULL DEFAULT '{}',
    summary             TEXT,
    is_person           BOOLEAN,
    job_id              TEXT,
    reply_job_id        TEXT,
    labels_applied      TEXT[]      NOT NULL DEFAULT '{}',
    notified_at         TIMESTAMPTZ,
    error               TEXT,
    triaged_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mail_messages_state_known
      CHECK (state IN ('received', 'claimed', 'over_cap', 'triaged', 'failed')),
    CONSTRAINT mail_messages_provider_unique UNIQUE (business_id, provider_message_id)
);

CREATE INDEX mail_messages_state_idx    ON mail_messages (business_id, state, received_at);
CREATE INDEX mail_messages_received_idx ON mail_messages (business_id, received_at);

CREATE TABLE mail_invoices (
    invoice_id       TEXT PRIMARY KEY,
    business_id      TEXT        NOT NULL,
    mail_id          TEXT        NOT NULL REFERENCES mail_messages (mail_id) ON DELETE CASCADE,
    supplier_address TEXT        NOT NULL,
    supplier_name    TEXT,
    invoice_number   TEXT,
    amount_text      TEXT,
    document_id      TEXT,
    file_name        TEXT,
    received_at      TIMESTAMPTZ NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mail_invoices_business_idx ON mail_invoices (business_id, received_at);
