-- 060_instruction_upload_source.sql
--
-- A file the owner attaches to an instruction on the dashboard ("צרפי
-- קובץ") is ingested as source 'instruction', not 'manual'. 'manual' is a
-- file in the document inbox — a stranger's document the conductor reads
-- under `unknown_external`. An upload is the owner's own input to his
-- instruction, and `documentsAwaitingRead` skips it by this column even when
-- the instruction never got as far as writing `boss_instructions` (refused,
-- crashed) — the attached-ids clause there stays as a second layer, for an
-- upload whose bytes deduplicated into an existing inbox row.
-- A new migration and not an edit of 012: the runner is keyed by file name.
ALTER TABLE documents DROP CONSTRAINT documents_source_known;
ALTER TABLE documents
  ADD CONSTRAINT documents_source_known
    CHECK (source IN ('manual', 'mail', 'api', 'instruction'));
