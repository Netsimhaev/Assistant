-- What the assistant proposed doing about a reading
-- (docs/superpowers/specs/2026-08-31-proposal-planner-design.md §10).
--
-- No unique index and no dedupe, unlike document_readings. A reading is a
-- claim about fixed text: the same brief under the same question deserves one
-- answer, and paying twice for it is waste. A proposal is a claim about what
-- is worth doing *now* — and the same document legitimately deserves a
-- different proposal next week, after the charter changed, after the ramp
-- rose, or after the owner rejected the first one and asked for another.
--
-- A rejected proposal is kept with the note the owner wrote. That note is the
-- only material from which an agreement rate could ever be measured, and a
-- measured agreement rate is the whole justification for raising the ramp
-- later. Discarding rejections would discard the evidence.
CREATE TABLE proposals (
    proposal_id    TEXT        PRIMARY KEY,
    business_id    TEXT        NOT NULL,
    reading_id     TEXT        NOT NULL REFERENCES document_readings (reading_id) ON DELETE CASCADE,
    status         TEXT        NOT NULL,
    reason         TEXT,
    -- The Proposal itself. Null exactly when the status is `unproposable`.
    content        JSONB,
    model          TEXT        NOT NULL,
    prompt_version TEXT        NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Set when the owner acts on it. `decided_note` is what they typed.
    decided_at     TIMESTAMPTZ,
    decided_note   TEXT,

    CONSTRAINT proposals_status_known
        CHECK (status IN ('proposed', 'unproposable')),
    CONSTRAINT proposals_content_present
        CHECK ((status = 'proposed') = (content IS NOT NULL))
);

CREATE INDEX proposals_by_reading_idx
    ON proposals (business_id, reading_id, created_at DESC);
