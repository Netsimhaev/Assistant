-- 044_mail_claims_and_stored_documents.sql
--
-- Two fixes from the mailbox poll's review.
--
-- 1. `documents.status = 'stored'`: a PDF is kept (file on disk, row here,
--    downloadable) but never extracted. A terminal status of its own rather
--    than `rejected`, which would tell the owner his supplier's invoice was
--    refused. `documentsAwaitingRead` selects `status = 'extracted'` only, so
--    a stored document is never offered to the conductor.
--
-- 2. `mail_messages.claimed_at`: when a poller claimed the row. A crash after
--    `claimMail` used to leave the row `claimed` forever (nothing re-reads
--    `claimed`); the poll now returns claims older than 30 minutes to
--    `received`. NULL on rows claimed before this migration, which the sweep
--    treats as stale.

ALTER TABLE documents DROP CONSTRAINT documents_status_known;
ALTER TABLE documents ADD CONSTRAINT documents_status_known
    CHECK (status IN ('pending', 'extracted', 'rejected', 'stored'));

ALTER TABLE mail_messages ADD COLUMN claimed_at TIMESTAMPTZ;
