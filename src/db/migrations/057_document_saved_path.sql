-- 057_document_saved_path.sql
--
-- Where a delivery job's `doc.save` copy landed (document production §9.3,
-- C7). The base folder's copies are the owner's own files: an erasure of a
-- contact never deletes them, but its preview must NAME them — by name and
-- path, under "נשארים בתיקייה שלך". Nothing recorded that path before: a
-- local step's output is not persisted, and the written name can carry a
-- " (2)" suffix the plan never knew. `runDocSave` writes both columns on the
-- delivery job's own `document_deliveries` row (one save step per delivery
-- job) after the file was written and verified.
--
-- `saved_path` can name a person (the filename comes from the spec), so the
-- erasure deletes this row with its job — after the preview listed it.
--
-- A new migration and not an edit of 055: the runner is keyed by file name.
ALTER TABLE document_deliveries
  ADD COLUMN saved_path TEXT,
  ADD COLUMN saved_at   TIMESTAMPTZ;
