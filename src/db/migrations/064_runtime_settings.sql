-- Multi-tenant stage A, step 3: per-business runtime settings, the server's
-- own secrets, and the server's key state (spec §5.4, §5.9).

-- One row per business. A business with NO row gets every channel off: no
-- approval email, no WhatsApp, no inbox — the same "a missing setting is a
-- switch, not a fault" rule `DOCUMENT_INBOX` already followed. Secrets are
-- never here: the SMTP password stays in the business's own `credentials`
-- under the fixed ref `NOTIFY_SMTP_PASS`.
--
-- Every daily cap is nullable, and NULL means "the server's default from the
-- environment" (`config.ts`). A stored 0 is a real value — it turns the
-- feature off for this business — and is never read as "unset".
CREATE TABLE business_runtime_settings (
    business_id                       TEXT PRIMARY KEY CHECK (business_id ~ '^[a-z0-9-]{3,63}$'),
    notify_to                         TEXT,
    notify_smtp_host                  TEXT,
    notify_smtp_port                  INT CHECK (notify_smtp_port > 0 AND notify_smtp_port <= 65535),
    notify_smtp_secure                BOOLEAN,
    notify_smtp_from                  TEXT,
    notify_smtp_user                  TEXT,
    notify_smtp_allow_cleartext       BOOLEAN NOT NULL DEFAULT false,
    mail_system                       TEXT,
    whatsapp_enabled                  BOOLEAN NOT NULL DEFAULT false,
    inbox_enabled                     BOOLEAN NOT NULL DEFAULT false,
    document_reads_per_day            INT CHECK (document_reads_per_day >= 0),
    documents_per_day                 INT CHECK (documents_per_day >= 0),
    mail_reads_per_day                INT CHECK (mail_reads_per_day >= 0),
    mail_curation_per_day             INT CHECK (mail_curation_per_day >= 0),
    curation_runs_per_day             INT CHECK (curation_runs_per_day >= 0),
    delegations_per_day               INT CHECK (delegations_per_day >= 0),
    ledger_nudges_per_day             INT CHECK (ledger_nudges_per_day >= 0),
    whatsapp_transcribe_boss_per_day  INT CHECK (whatsapp_transcribe_boss_per_day >= 0),
    whatsapp_transcribe_other_per_day INT CHECK (whatsapp_transcribe_other_per_day >= 0),
    whatsapp_instructions_per_day     INT CHECK (whatsapp_instructions_per_day >= 0),
    whatsapp_question_window_minutes  INT CHECK (whatsapp_question_window_minutes >= 0),
    whatsapp_max_audio_seconds        INT CHECK (whatsapp_max_audio_seconds >= 0),
    updated_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The APPLICATION's secrets, not any business's: the Google and Microsoft
-- OAuth client id/secret. Sealed under the authenticated data `platform:<ref>`
-- (src/tenancy/platform-credentials.ts) — a shape no business secret
-- (`^[A-Z0-9_]+$`) and no grant (`grant:<system>`) can ever take, so a row
-- moved between this table and `credentials` fails to open instead of
-- opening as the wrong thing.
CREATE TABLE platform_credentials (
    ref         TEXT PRIMARY KEY CHECK (ref ~ '^[A-Z0-9_]+$'),
    key_id      TEXT NOT NULL,
    nonce       BYTEA NOT NULL,
    ciphertext  BYTEA NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The master key belongs to the server, so its key state is one row for the
-- server rather than one per business (spec §5.9). Created and backfilled
-- here; NOT read yet — `liveKeyId` switches to it in a later step, and
-- `credential_key_state` stays until then.
CREATE TABLE server_key_state (
    singleton    BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    key_id       TEXT NOT NULL,
    check_nonce  BYTEA NOT NULL,
    check_value  BYTEA NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill only when the install holds exactly one key state: with two, which
-- one is "the server's" is a guess, and a guess here seals the wrong key.
INSERT INTO server_key_state (singleton, key_id, check_nonce, check_value, created_at)
SELECT true, key_id, check_nonce, check_value, created_at
  FROM credential_key_state
 WHERE (SELECT count(*) FROM credential_key_state) = 1;
