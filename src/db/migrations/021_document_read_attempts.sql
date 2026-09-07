-- 021_document_read_attempts.sql
--
-- The conductor needs somewhere to count failed understanding attempts.
--
-- These two columns belong to the conductor and deliberately do NOT touch
-- `status`, whose CHECK constraint names exactly three values (pending,
-- extracted, rejected) and describes what happened during *ingest*. A failed
-- model read is not an ingest outcome, and widening that constraint to say so
-- would blur the one column that answers "did we get bytes out of this file".

ALTER TABLE documents
    ADD COLUMN read_attempts INT NOT NULL DEFAULT 0,
    ADD COLUMN read_error    TEXT;

COMMENT ON COLUMN documents.read_attempts IS
    'Conductor understanding attempts. At 3 the document stops being selected.';
COMMENT ON COLUMN documents.read_error IS
    'Last failure message from the conductor. Null when none.';
