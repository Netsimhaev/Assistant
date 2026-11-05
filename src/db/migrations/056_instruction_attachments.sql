-- 056_instruction_attachments.sql
--
-- The files the owner attached to an instruction on the dashboard ("צרפי
-- קובץ", document production D14). Ids only — the files themselves are
-- `documents` rows, ingested like any other. The column is what tells
-- `doc.produce` which of a production's sources the OWNER supplied, so the
-- production loop can fence them as his (`boss`) rather than as a stranger's.
-- Written by `runInstruction` only, from ids the dashboard ingested in that
-- same request; never by a plan. Deleted with its row (erasure deletes
-- `boss_instructions` by job).
ALTER TABLE boss_instructions
  ADD COLUMN attached_document_ids TEXT[] NOT NULL DEFAULT '{}';
