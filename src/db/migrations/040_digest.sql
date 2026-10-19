-- 040_digest.sql
--
-- Two tables, and they are deliberately not one.
--
-- `digest_settings` is the owner's CHOICE — one row per business, like
-- `autonomy_mode` (026). `digests` is the RECORD of what was sent, and spec §2
-- decision 4 is that it is snapshotted and never recomputed: a digest whose
-- numbers change afterwards is not a record of what the owner was told, and it
-- is worthless at the exact moment he needs it ("what did you tell me on
-- Tuesday").
--
-- The CHECKs on the hour and day columns are the enforcement layer the spec
-- names in §9: these are the owner's choices in the database, not environment
-- values, so an invalid hour must be impossible to WRITE rather than read as
-- "switch off" at run time. A setting of his that vanishes quietly because a
-- reader mis-parsed it is exactly the behaviour this project refuses.

CREATE TABLE digest_settings (
    business_id   TEXT PRIMARY KEY,
    schedule      TEXT        NOT NULL,
    daily_hour    SMALLINT    NOT NULL,
    weekly_day    SMALLINT    NOT NULL,
    weekly_hour   SMALLINT    NOT NULL,
    to_email      BOOLEAN     NOT NULL,
    to_whatsapp   BOOLEAN     NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by    TEXT        NOT NULL,
    CONSTRAINT digest_settings_schedule_known
      CHECK (schedule IN ('off', 'daily', 'weekly', 'both')),
    CONSTRAINT digest_settings_daily_hour_valid  CHECK (daily_hour  BETWEEN 0 AND 23),
    CONSTRAINT digest_settings_weekly_hour_valid CHECK (weekly_hour BETWEEN 0 AND 23),
    CONSTRAINT digest_settings_weekly_day_valid  CHECK (weekly_day  BETWEEN 0 AND 6)
);

-- `kind` is the digest's own type, not a channel: one row covers all three
-- destinations, and each destination's outcome is a column below. Storing one
-- row per channel would let the three disagree about what the text said.
--
-- `window_start`/`window_end` are stored because the digest states its own
-- window in its text (spec §5), and a reader must be able to check that claim
-- against the row rather than trust the prose.
--
-- The three delivery columns are nullable on purpose: NULL means "not
-- attempted" (the owner did not enable that channel), which is a different
-- fact from 'skipped_not_connected' — the channel was wanted and could not be
-- reached. Spec §6: "not sent" and "nothing to send" must not look alike.
CREATE TABLE digests (
    digest_id     TEXT PRIMARY KEY,
    business_id   TEXT        NOT NULL,
    kind          TEXT        NOT NULL,
    window_start  TIMESTAMPTZ NOT NULL,
    window_end    TIMESTAMPTZ NOT NULL,
    body          TEXT        NOT NULL,
    had_content   BOOLEAN     NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    screen_at     TIMESTAMPTZ,
    email_state   TEXT,
    whatsapp_state TEXT,
    CONSTRAINT digests_kind_known CHECK (kind IN ('daily', 'weekly')),
    CONSTRAINT digests_window_ordered CHECK (window_end > window_start),
    CONSTRAINT digests_email_state_known
      CHECK (email_state IS NULL OR email_state IN ('sent', 'failed', 'skipped_not_connected')),
    CONSTRAINT digests_whatsapp_state_known
      CHECK (whatsapp_state IS NULL OR whatsapp_state IN ('sent', 'failed', 'skipped_not_connected'))
);

-- The scheduler asks "what was the last window of this kind I sent?" on every
-- pass; without this it is a sequential scan that grows forever.
CREATE INDEX digests_business_kind_window_idx
  ON digests (business_id, kind, window_end DESC);
