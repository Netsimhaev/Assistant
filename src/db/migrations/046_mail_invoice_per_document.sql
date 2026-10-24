-- One invoice row per (mail, document).
--
-- Since 23/10 an invoice found inside a PDF attachment is recorded on its own
-- row (spec §9.3), next to the mail-level row the body names. The poll pass
-- checks `hasInvoiceForDocument` before each insert; this index is the
-- backstop for the race and the re-handle, and `insertInvoice` inserts with
-- ON CONFLICT DO NOTHING against it.
--
-- Partial: a row with no document (a body invoice with nothing attached) is
-- not bound — those are kept to one per mail by `hasInvoiceForMail`.
--
-- No existing duplicate can block it: before this migration the only writer
-- was the mail-level row, at most one per mail (`hasInvoiceForMail`), so no
-- (mail_id, document_id) pair could occur twice.
CREATE UNIQUE INDEX mail_invoices_mail_document_uniq
  ON mail_invoices (business_id, mail_id, document_id)
  WHERE document_id IS NOT NULL;
