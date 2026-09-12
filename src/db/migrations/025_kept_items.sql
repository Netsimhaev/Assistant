-- 025_kept_items.sql
--
-- What the owner said to keep.
--
-- One table rather than a `kept_at` column on documents, memories and jobs.
-- The question "what am I keeping?" has to be answerable in one query, the
-- revoke button has to write in one place, and adding a fourth keepable kind
-- must not mean a fourth migration altering a fourth table.
--
-- Keeping is permanent until revoked, and it never hides: every erasure
-- preview lists what it is skipping and why (spec §6).

CREATE TABLE kept_items (
    business_id TEXT        NOT NULL,
    -- Closed at the database. A fourth kind is a migration and a decision,
    -- never a value that arrives at runtime.
    item_kind   TEXT        NOT NULL CHECK (item_kind IN ('document', 'memory', 'job')),
    item_id     TEXT        NOT NULL,
    kept_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Why the owner kept it, in their words. Optional: the act is the point.
    note        TEXT,

    PRIMARY KEY (business_id, item_kind, item_id),

    CONSTRAINT kept_items_id_not_empty CHECK (length(btrim(item_id)) > 0),
    CONSTRAINT kept_items_note_bounded CHECK (note IS NULL OR length(note) <= 500)
);

CREATE INDEX kept_items_business_idx ON kept_items (business_id, kept_at DESC);
