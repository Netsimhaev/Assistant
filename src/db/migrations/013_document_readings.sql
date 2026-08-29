-- What a model concluded about a document
-- (docs/superpowers/specs/2026-08-29-reading-comprehension-design.md §8).
--
-- A separate table and not a fourth `kind` in `document_artifacts`. An
-- artefact is what was extracted from the file deterministically; a reading is
-- a model's *claim about* it. In one table a later reader could not tell the
-- two apart, and that distinction is what every control in §7 rests on.
--
-- `status = 'unreadable'` is stored, not discarded. "We tried to understand it
-- and could not" is a fact about the record; no row at all says "we never
-- tried", which is a different claim. The same rule the orchestrator already
-- holds for an `unknown` step result.
CREATE TABLE document_readings (
    reading_id      TEXT        PRIMARY KEY,
    business_id     TEXT        NOT NULL,
    document_id     TEXT        NOT NULL REFERENCES documents (document_id) ON DELETE CASCADE,
    status          TEXT        NOT NULL,
    -- Human-readable reason for an `unreadable` status. Null otherwise.
    reason          TEXT,
    -- The `Reading` itself. Null exactly when the status is `unreadable`.
    content         JSONB,
    -- Trust of the source this reading was made from. A reading of an
    -- `unknown_external` document stays `unknown_external` however fluent the
    -- summary reads; nothing here may raise a trust level.
    provenance      TEXT        NOT NULL,
    model           TEXT        NOT NULL,
    -- A hand-raised constant, not a hash of the prompt: a hash would change
    -- on a comma and invalidate every cached reading while the question asked
    -- stayed identical.
    prompt_version  TEXT        NOT NULL,
    -- sha256 of the brief, which is what was actually read. Not the document's
    -- own sha256: changing a truncation ceiling changes the brief without
    -- changing the document, and two readings made from different text are not
    -- the same reading.
    brief_hash      TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT document_readings_status_known
        CHECK (status IN ('read', 'unreadable')),
    -- Content is present exactly when the reading succeeded. Enforced here
    -- rather than trusted: a `read` row with no content would be a success
    -- record with nothing in it.
    CONSTRAINT document_readings_content_present
        CHECK ((status = 'read') = (content IS NOT NULL))
);

-- Same document, same brief, same prompt version — one reading. Two readings
-- cost money twice and may return two different answers to one question.
CREATE UNIQUE INDEX document_readings_dedupe_idx
    ON document_readings (business_id, document_id, brief_hash, prompt_version);

-- The lookup behind `loadLatestReading`.
CREATE INDEX document_readings_recent_idx
    ON document_readings (business_id, document_id, created_at DESC);
