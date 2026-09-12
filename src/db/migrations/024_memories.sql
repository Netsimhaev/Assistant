-- 024_memories.sql
--
-- The first memory layer that actually stores anything.
--
-- `001_spine.sql` says the memory layers arrive in Phase 1 and that L3 needs
-- pgvector. This is not that: no embeddings, no similarity, no L3. It is the
-- durable half of "record and remember" — the only two things the owner
-- authorised the assistant to do on its own initiative — so that
-- `memory.write_*` and `memory.recall` stop returning nothing.
--
-- **One table with a closed `kind`, not three tables.** The three kinds differ
-- in what identifies them, not in what they are: an entity is keyed by its id,
-- a preference by a subject plus an attribute, a chunk by nothing at all. Three
-- tables would mean three sets of the same provenance and retirement columns,
-- and recall would have to union them back together on every read.
--
-- **`provenance` is the column this table exists to carry.** A memory written
-- while reading a supplier's document is a claim that supplier made, and it
-- must still look like one a month later. Recall returns this with every row
-- precisely so a later reader cannot mistake it for something the owner said.
-- The value is taken from the job record by the writer, never from a payload:
-- a caller able to choose it is a caller able to launder an injected claim into
-- an established fact.

CREATE TABLE memories (
    memory_id      TEXT        PRIMARY KEY,
    business_id    TEXT        NOT NULL,

    -- Closed at the database, not only in TypeScript. A fourth kind is a
    -- migration and a decision, never a value that arrives at runtime.
    kind           TEXT        NOT NULL
                   CHECK (kind IN ('entity', 'preference', 'chunk')),

    -- Who or what this is about: an entity id, or the subject a preference
    -- belongs to. A chunk carries the subject it was recorded against.
    subject_key    TEXT        NOT NULL,

    -- Which preference. NULL for entity and chunk, and the partial unique
    -- index below depends on that being true.
    attribute      TEXT,

    -- The value, shaped by kind. JSONB so recall can read fields back without
    -- a second parse, bounded so one memory cannot become a document.
    body           JSONB       NOT NULL,

    -- The trust level of the job that wrote this. See the docblock above: this
    -- is the whole point of the table.
    provenance     TEXT        NOT NULL,

    -- Deliberately not a foreign key. A memory outlives the job that wrote it
    -- — that is what makes it memory — and `ON DELETE CASCADE` would erase the
    -- business's knowledge along with its job history. The id is kept so the
    -- audit trail can still be walked back from a recalled claim.
    written_by_job TEXT,

    -- Free text saying where the claim came from, when the writer knows:
    -- a document id and part, a sentence the owner typed.
    source_ref     TEXT,

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Retirement is soft, always. `memory.retire` means "this stopped being
    -- true", and a business that cannot say what it used to believe cannot
    -- explain a decision it made last quarter.
    retired_at     TIMESTAMPTZ,
    retired_reason TEXT,

    CONSTRAINT memories_subject_not_empty CHECK (length(btrim(subject_key)) > 0),
    CONSTRAINT memories_subject_bounded   CHECK (length(subject_key) <= 200),
    CONSTRAINT memories_attribute_bounded CHECK (attribute IS NULL OR length(attribute) <= 200),
    CONSTRAINT memories_body_bounded      CHECK (length(body::text) <= 4000),
    -- The shape each kind must hold, enforced where it cannot be bypassed.
    CONSTRAINT memories_attribute_by_kind CHECK (
        (kind = 'preference' AND attribute IS NOT NULL)
        OR (kind IN ('entity', 'chunk') AND attribute IS NULL)
    ),
    CONSTRAINT memories_retired_together CHECK (
        (retired_at IS NULL AND retired_reason IS NULL)
        OR (retired_at IS NOT NULL AND retired_reason IS NOT NULL)
    )
);

-- One live entity per id, and one live value per preference. Partial, so a
-- retired row does not block the fact that replaced it — which is what makes
-- "this used to be true" and "this is true" able to coexist.
CREATE UNIQUE INDEX memories_live_entity_idx
    ON memories (business_id, subject_key)
    WHERE kind = 'entity' AND retired_at IS NULL;

CREATE UNIQUE INDEX memories_live_preference_idx
    ON memories (business_id, subject_key, attribute)
    WHERE kind = 'preference' AND retired_at IS NULL;

-- Recall reads by subject, newest first, and skips retired rows.
CREATE INDEX memories_recall_idx
    ON memories (business_id, subject_key, created_at DESC)
    WHERE retired_at IS NULL;
