-- A document that entered the intake pipeline, and the parts extracted from
-- it (docs/superpowers/specs/2026-08-28-document-intake-design.md §3.1, §3.2).
--
-- The hash is unique PER BUSINESS, not globally: two different businesses on
-- the same installation can legitimately receive byte-identical files (a
-- shared supplier price list, a standard contract template), and one
-- tenant's dedupe must never short-circuit into serving another tenant's
-- document. `(business_id, sha256)` is the same file arriving twice for the
-- same business — that is the only case §8 means by "already exists".
--
-- `content` is JSONB and not a file on disk. A parsed table of 800 rows is
-- data someone will query — "what was the unit price in that row" — not a
-- document to hand back whole. An oversized artefact is truncated and
-- flagged (`truncated`) rather than growing this column without bound; see
-- §5.3 for the ceilings that keep it that way.
--
-- `document_artifacts.document_id` references `documents.document_id` alone,
-- not the pair — the same shape `job_steps` already uses against `jobs`
-- (001_spine.sql). `business_id` still rides on both tables because every
-- query in this codebase filters by it directly; the FK exists for
-- referential integrity of the row's existence, not as the tenant check.

CREATE TABLE documents (
    document_id    TEXT        PRIMARY KEY,
    business_id    TEXT        NOT NULL,
    -- Who brought it in. `manual` today; `mail` and `api` are named now so
    -- the column never needs a widening migration when those callers land.
    source         TEXT        NOT NULL,
    -- As it arrived. Never a path component — see §5.5, and store.ts, which
    -- never interpolates this column into a filesystem path.
    original_name  TEXT        NOT NULL,
    -- From the file's own bytes (§5.1), never from the original name's
    -- extension.
    media_type     TEXT        NOT NULL,
    sha256         TEXT        NOT NULL,
    byte_size      BIGINT      NOT NULL,
    -- Relative to the document root (§3.5). Built entirely from
    -- system-generated ids, never from original_name.
    stored_path    TEXT        NOT NULL,
    status         TEXT        NOT NULL DEFAULT 'pending',
    -- Human-readable reason for a `rejected` status. Null otherwise.
    reason         TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    extracted_at   TIMESTAMPTZ,

    CONSTRAINT documents_source_known
        CHECK (source IN ('manual', 'mail', 'api')),
    CONSTRAINT documents_status_known
        CHECK (status IN ('pending', 'extracted', 'rejected'))
);

-- The same bytes sent twice are one document, not two (§8, "same sha256
-- already exists"). Scoped per business — see the header comment above.
CREATE UNIQUE INDEX documents_business_sha_idx
    ON documents (business_id, sha256);

CREATE TABLE document_artifacts (
    business_id  TEXT        NOT NULL,
    document_id  TEXT        NOT NULL REFERENCES documents (document_id) ON DELETE CASCADE,
    -- Stable order among a document's parts — sheet order, section order.
    ordinal      INT         NOT NULL,
    kind         TEXT        NOT NULL,
    -- "מחירים" for a sheet, "תנאי תשלום" for a section. Null when the
    -- format carries no name for the part (e.g. a bare CSV table).
    part_name    TEXT,
    content      JSONB       NOT NULL,
    flags        TEXT[]      NOT NULL DEFAULT '{}',

    PRIMARY KEY (business_id, document_id, ordinal),
    CONSTRAINT document_artifacts_kind_known
        CHECK (kind IN ('text', 'table', 'outline'))
);
