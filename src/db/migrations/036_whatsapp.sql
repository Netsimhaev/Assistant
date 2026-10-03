-- src/db/migrations/036_whatsapp.sql
--
-- The conversation between the owner and the assistant, and everything else
-- that arrives at the same number.
--
-- `provider_message_id` is UNIQUE per business and that is the whole dedupe
-- mechanism: GREEN-API may redeliver, and "we probably already saw this" is
-- not a control. It is NULL for outbound rows, which the assistant originates
-- and the provider has not named yet; a partial unique index covers only the
-- rows that have one.
--
-- `state` exists because the claim is written BEFORE `runInstruction` is
-- called. A crash between the two loses one instruction rather than sending a
-- second email — the safe direction, and the same choice
-- `markContentIngested` makes in `src/documents/read.ts`.
--
-- Five states, not four: 'received', 'claimed', 'handled' and 'failed' are
-- this task's own lifecycle for an inbound message being acted on.
-- 'reported' is a later task's value, added here because the CHECK
-- constraint and the TypeScript union must agree and this migration is the
-- only place either can be amended without a second one. It is terminal and
-- means the owner has been told what came of the instruction this message
-- opened — nothing in this task writes it.
CREATE TABLE whatsapp_messages (
    id                   TEXT        PRIMARY KEY,
    business_id          TEXT        NOT NULL,
    provider_message_id  TEXT,
    direction            TEXT        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    sender_number        TEXT,
    sender_kind          TEXT        CHECK (sender_kind IN ('principal', 'other')),
    body                 TEXT,
    transcript           TEXT,
    media_kind           TEXT,
    provider_timestamp   TIMESTAMPTZ NOT NULL,
    state                TEXT        NOT NULL CHECK (state IN ('received', 'claimed', 'handled', 'failed', 'reported')),
    job_id               TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX whatsapp_messages_provider_idx
    ON whatsapp_messages (business_id, provider_message_id)
    WHERE provider_message_id IS NOT NULL;

CREATE INDEX whatsapp_messages_pending_idx
    ON whatsapp_messages (business_id, state, provider_timestamp)
    WHERE state = 'received';

CREATE INDEX whatsapp_messages_convo_idx
    ON whatsapp_messages (business_id, provider_timestamp DESC);

-- Which inbound message opened this job, so the report knows where to reply.
-- `job_id` on the message alone cannot answer that: several messages can carry
-- the same job, and only one of them opened it.
ALTER TABLE jobs ADD COLUMN whatsapp_message_id TEXT;
