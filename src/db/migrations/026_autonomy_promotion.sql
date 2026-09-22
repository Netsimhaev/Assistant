-- The owner's dial. One row per business; absent means `off`.
CREATE TABLE autonomy_mode (
    business_id TEXT PRIMARY KEY,
    mode        TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  TEXT NOT NULL,
    CONSTRAINT autonomy_mode_known CHECK (mode IN ('off', 'ask', 'learn'))
);

-- The owner marking an autonomous action as wrong. Feeds BOTH the demotion
-- (spec 6.1) and the memory the assistant carries forward (spec 7).
CREATE TABLE autonomy_marks (
    mark_id      TEXT PRIMARY KEY,
    business_id  TEXT NOT NULL,
    job_id       TEXT NOT NULL,
    step_id      TEXT NOT NULL,
    action_class TEXT NOT NULL,
    note         TEXT NOT NULL,
    marked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    marked_by    TEXT NOT NULL
);
CREATE INDEX autonomy_marks_class_idx ON autonomy_marks (business_id, action_class, marked_at DESC);

-- Every promotion and every demotion. This table is why the demotion count
-- stays DERIVED (spec 6.4, 9.1): "has this class fallen twice" is a row
-- count here, never a counter maintained beside the truth.
CREATE TABLE autonomy_events (
    event_id     TEXT PRIMARY KEY,
    business_id  TEXT NOT NULL,
    action_class TEXT NOT NULL,
    direction    TEXT NOT NULL,
    from_level   TEXT NOT NULL,
    to_level     TEXT NOT NULL,
    reason       TEXT NOT NULL,
    at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT autonomy_events_direction CHECK (direction IN ('promote', 'demote'))
);
CREATE INDEX autonomy_events_class_idx ON autonomy_events (business_id, action_class, at DESC);
