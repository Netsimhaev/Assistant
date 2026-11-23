-- WhatsApp contacts phase 1: two lookup indexes the final review asked for.
-- A new file, never an edit of 083 (the runner follows file names, so an
-- edit in place would leave every database that already ran 083 without them).
--
-- contact_conversations is read by its card job in the approved-reply
-- exemption, the contact-card housekeeping and the decision log
-- (`card_job_id = job`); contact_documents by the contact's number (tier-2
-- uploaded invoices and erasure).
CREATE INDEX IF NOT EXISTS contact_conversations_card_job_idx
    ON contact_conversations (business_id, card_job_id);

CREATE INDEX IF NOT EXISTS contact_documents_contact_key_idx
    ON contact_documents (business_id, contact_key);
