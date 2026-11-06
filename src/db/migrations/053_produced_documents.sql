-- 053_produced_documents.sql
--
-- Document production: the owner asks for a Word / PDF / Excel / PowerPoint
-- file, the assistant drafts a spec, builds it in code, checks it twice and
-- raises a card. Four tables; every one carries `business_id` except the
-- versions, which belong to a production.
--
-- No FK on `origin_job_id`: a job is scrubbed, never deleted (like 047).

-- One row per request. `stage` is the production state machine; `lease_*`
-- keeps two schedulers off the same production. `destination` is
-- {mode:'send', to, subject, body} | {mode:'save', folder}.
CREATE TABLE document_productions (
    production_id       TEXT PRIMARY KEY,
    business_id         TEXT        NOT NULL,
    origin_job_id       TEXT        NOT NULL,
    instruction_text    TEXT        NOT NULL,
    text_origin         TEXT        NOT NULL,
    format              TEXT        NOT NULL,
    language            TEXT        NOT NULL,
    kind                TEXT        NOT NULL,
    destination         JSONB       NOT NULL,
    source_document_ids TEXT[]      NOT NULL DEFAULT '{}',
    stage               TEXT        NOT NULL DEFAULT 'queued',
    attempt             INT         NOT NULL DEFAULT 0,
    findings            JSONB,
    lease_until         TIMESTAMPTZ,
    leased_by           TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT document_productions_stage_known
      CHECK (stage IN ('queued','drafting','building','check1','check2','fixing','ready','failed_checks','failed'))
);

CREATE INDEX document_productions_business_stage_idx ON document_productions (business_id, stage);

-- One row per built file. `stored_path` is relative to the document root;
-- `sha256` is the same lowercase-hex shape audit_log and signatures carry.
CREATE TABLE document_versions (
    version_id    TEXT PRIMARY KEY,
    production_id TEXT        NOT NULL REFERENCES document_productions (production_id) ON DELETE CASCADE,
    version_no    INT         NOT NULL,
    spec          JSONB       NOT NULL,
    stored_path   TEXT        NOT NULL,
    sha256        TEXT        NOT NULL,
    size_bytes    BIGINT      NOT NULL,
    check1        JSONB,
    check2        JSONB,
    superseded_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT document_versions_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT document_versions_unique_no UNIQUE (production_id, version_no)
);

-- The owner's approval card; one per version. `delivery_plans` holds one plan
-- per destination option, each with its `planHash`.
CREATE TABLE document_cards (
    card_id               TEXT PRIMARY KEY,
    business_id           TEXT        NOT NULL,
    version_id            TEXT        NOT NULL UNIQUE REFERENCES document_versions (version_id) ON DELETE CASCADE,
    state                 TEXT        NOT NULL DEFAULT 'open',
    delivery_plans        JSONB       NOT NULL DEFAULT '[]',
    whatsapp_state        TEXT,
    email_state           TEXT,
    whatsapp_delivered_at TIMESTAMPTZ,
    seen_at               TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at            TIMESTAMPTZ,
    delivery_job_id       TEXT,
    CONSTRAINT document_cards_state_known
      CHECK (state IN ('open','approved','saved','fix_requested','superseded','failed_send'))
);

CREATE INDEX document_cards_business_state_idx ON document_cards (business_id, state);

-- Where the owner is told about finished documents. At least one channel, in
-- two layers (code refuses first; this is the layer for anyone writing SQL).
CREATE TABLE document_settings (
    business_id TEXT PRIMARY KEY,
    to_whatsapp BOOLEAN     NOT NULL,
    to_email    BOOLEAN     NOT NULL,
    to_screen   BOOLEAN     NOT NULL,
    base_folder TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT document_settings_at_least_one_channel
      CHECK (to_whatsapp OR to_email OR to_screen)
);
