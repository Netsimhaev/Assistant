-- 052_task_ledger.sql
--
-- The task ledger: things the owner is waiting on or owes (money, meetings,
-- leads, replies, projects), written ONLY from owner instructions and read by
-- the follow-up loop. Six tables; ids are TEXT ulids with prefixes
-- LI-/LE-/LR-/LW-/LC-. Every table carries `business_id`.

-- One row per tracked item. Status transitions are conditional UPDATEs in
-- code; the CHECKs below are the second layer for anyone who writes SQL.
--
-- `counterparty_email_verified = false OR counterparty_email IS NOT NULL`: a
-- "verified" flag on an address that does not exist is a claim about nothing,
-- and a nudge is only ever sent to a verified address.
--
-- `amount_minor >= 0`: money is an integer in minor units, never negative.
--
-- `nudge_job_id` is the nudge in flight (NULL when none), so a second pass
-- cannot start a second nudge for the same item.
-- `evidence_after` is the instant before which mail is not evidence of
-- anything for this item (set on creation and on reopen).
-- No FK on `origin_job_id`: a job is scrubbed, never deleted (like 047).
CREATE TABLE ledger_items (
    item_id                     TEXT PRIMARY KEY,
    business_id                 TEXT        NOT NULL,
    family                      TEXT        NOT NULL,
    description                 TEXT        NOT NULL,
    due_at                      TIMESTAMPTZ,
    due_is_date_only            BOOLEAN     NOT NULL DEFAULT false,
    importance                  TEXT        NOT NULL DEFAULT 'normal',
    importance_manual           BOOLEAN     NOT NULL DEFAULT false,
    counterparty_name           TEXT,
    counterparty_email          TEXT,
    counterparty_email_verified BOOLEAN     NOT NULL DEFAULT false,
    counterparty_domain         TEXT,
    reference                   TEXT,
    amount_minor                BIGINT,
    stages                      JSONB       NOT NULL DEFAULT '[]',
    proposed_stages             JSONB,
    status                      TEXT        NOT NULL DEFAULT 'open',
    nudge_count                 INT         NOT NULL DEFAULT 0,
    nudge_job_id                TEXT,
    evidence_after              TIMESTAMPTZ NOT NULL DEFAULT now(),
    origin_job_id               TEXT        NOT NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at                   TIMESTAMPTZ,
    CONSTRAINT ledger_items_family_known
      CHECK (family IN ('money_in','money_out','meetings','warm_leads','awaiting_reply','projects')),
    CONSTRAINT ledger_items_status_known
      CHECK (status IN ('open','stuck','closed_by_evidence','done','cancelled')),
    CONSTRAINT ledger_items_importance_known
      CHECK (importance IN ('normal','critical')),
    CONSTRAINT ledger_items_amount_nonnegative
      CHECK (amount_minor IS NULL OR amount_minor >= 0),
    CONSTRAINT ledger_items_verified_needs_email
      CHECK (counterparty_email_verified = false OR counterparty_email IS NOT NULL)
);

CREATE INDEX ledger_items_business_status_idx ON ledger_items (business_id, status);

-- History of an item. `job_id` is nullable (the job that caused the event, if
-- any) and has no FK, like `action_updates.job_id`. Cascades with the item.
CREATE TABLE ledger_events (
    event_id    TEXT PRIMARY KEY,
    business_id TEXT        NOT NULL,
    item_id     TEXT        NOT NULL REFERENCES ledger_items (item_id) ON DELETE CASCADE,
    kind        TEXT        NOT NULL,
    job_id      TEXT,
    mail_id     TEXT,
    note        TEXT,
    by_whom     TEXT        NOT NULL,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ledger_events_kind_known
      CHECK (kind IN ('created','updated','reminded','nudged','nudge_fallback','closed_by_evidence',
                      'reopened','done','cancelled','snoozed','stuck','held','not_held',
                      'stages_saved','address_confirmed','pace_alert'))
);

CREATE INDEX ledger_events_item_idx ON ledger_events (item_id, at);

-- The owner's choices, one row per business. Same second layer as 047: the
-- `at_least_one_channel` CHECK makes a reminder that goes nowhere impossible
-- to write. `modes->>'money_out' = 'remind'`: money the owner owes is never
-- acted on automatically — it can only be reminded about, whoever writes the row.
CREATE TABLE ledger_settings (
    business_id                   TEXT PRIMARY KEY,
    modes                         JSONB       NOT NULL,
    to_whatsapp                   BOOLEAN     NOT NULL,
    to_email                      BOOLEAN     NOT NULL,
    to_screen                     BOOLEAN     NOT NULL,
    meeting_lead_minutes          INT         NOT NULL,
    meeting_lead_minutes_critical INT[]       NOT NULL,
    due_lead_days_critical        INT         NOT NULL,
    nudge_after_business_days     INT         NOT NULL,
    checkin_every_days            INT         NOT NULL,
    checkin_every_days_critical   INT         NOT NULL,
    daily_hour                    INT         NOT NULL,
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by                    TEXT        NOT NULL,
    CONSTRAINT ledger_settings_at_least_one_channel
      CHECK (to_whatsapp OR to_email OR to_screen),
    CONSTRAINT ledger_settings_daily_hour_range
      CHECK (daily_hour BETWEEN 0 AND 23),
    CONSTRAINT ledger_settings_money_out_remind_only
      CHECK (modes->>'money_out' = 'remind')
);

-- Owner-defined rules that make an item critical. Exactly the field of the
-- rule's kind is set: a rule with a stray second field would be ambiguous
-- about what it matches. `match` is stored lower-case (name/email/domain).
CREATE TABLE ledger_critical_rules (
    rule_id      TEXT PRIMARY KEY,
    business_id  TEXT        NOT NULL,
    kind         TEXT        NOT NULL,
    family       TEXT,
    amount_minor BIGINT,
    match        TEXT,
    created_by   TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ledger_critical_rules_kind_known
      CHECK (kind IN ('family','amount_over','counterparty')),
    CONSTRAINT ledger_critical_rules_one_field
      CHECK (
        (kind = 'family'       AND family IS NOT NULL AND amount_minor IS NULL AND match IS NULL) OR
        (kind = 'amount_over'  AND amount_minor IS NOT NULL AND family IS NULL AND match IS NULL) OR
        (kind = 'counterparty' AND match IS NOT NULL AND family IS NULL AND amount_minor IS NULL)
      )
);

-- One row per reminder slot actually claimed. UNIQUE (business_id, item_id,
-- slot) is the claim-before-send: a slot reminds once, however many passes
-- look at it. Delivery columns have 047's meaning: NULL = channel not chosen,
-- 'skipped_not_connected' = chosen but unreachable; the screen has no state
-- column, `seen_at` NULL means not seen. `body` is content about a
-- counterparty (erasure must reach it).
CREATE TABLE ledger_reminders (
    reminder_id    TEXT PRIMARY KEY,
    business_id    TEXT        NOT NULL,
    item_id        TEXT        NOT NULL REFERENCES ledger_items (item_id) ON DELETE CASCADE,
    slot           TEXT        NOT NULL,
    kind           TEXT        NOT NULL,
    body           TEXT        NOT NULL,
    email_state    TEXT,
    whatsapp_state TEXT,
    seen_at        TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ledger_reminders_one_per_slot UNIQUE (business_id, item_id, slot),
    CONSTRAINT ledger_reminders_email_state_known
      CHECK (email_state IS NULL OR email_state IN ('sent', 'failed', 'skipped_not_connected')),
    CONSTRAINT ledger_reminders_whatsapp_state_known
      CHECK (whatsapp_state IS NULL OR whatsapp_state IN ('sent', 'failed', 'skipped_not_connected'))
);

-- A WhatsApp digest listing items by number so the owner can answer "2 done".
-- `items` is the item ids in display order (1-based numbering). `sent_at` is
-- NULL until the send returned ok: a batch that was never delivered must not
-- be answerable.
CREATE TABLE ledger_whatsapp_batches (
    batch_id    TEXT PRIMARY KEY,
    business_id TEXT        NOT NULL,
    items       TEXT[]      NOT NULL,
    sent_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
