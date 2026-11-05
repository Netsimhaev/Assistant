-- 058_document_saved_paths.sql
--
-- Every copy, not the last one. 057 gave a delivery job ONE `saved_path`,
-- overwritten on each save; a second copy written by the same delivery job
-- (an at-least-once re-run of its `doc.save` step lands as " (2)") would
-- have replaced the first in the record, and an erasure preview would then
-- tell the owner about one file while two sit on his disk. The erasure never
-- deletes these copies (spec C7) — the list exists only so the owner is told,
-- and a list that can forget an entry tells him less than the truth.
--
-- `saved_paths` is appended to by `recordSavedPath` (`production/save.ts`),
-- never overwritten. Existing values move over; the 057 columns go.
-- A new migration and not an edit of 057: the runner is keyed by file name.
ALTER TABLE document_deliveries
  ADD COLUMN saved_paths TEXT[] NOT NULL DEFAULT '{}';

UPDATE document_deliveries SET saved_paths = ARRAY[saved_path] WHERE saved_path IS NOT NULL;

ALTER TABLE document_deliveries
  DROP COLUMN saved_path,
  DROP COLUMN saved_at;
