-- 055_document_deliveries.sql
--
-- Every delivery job a document card's approval ever created, kept for good
-- (document production §5.7, C17). `document_cards.delivery_job_id` names a
-- card's CURRENT delivery — the one the attachment and save gates check — and
-- is overwritten when a returned card is approved again. Without a durable
-- record the earlier delivery job lost its marker at that moment and became a
-- boss command the re-ask would ask about. Written only by
-- `approveDocumentCard`, in the transaction that creates the job.
--
-- No FK on `job_id`: a job is scrubbed, never deleted (like 047, 053).
CREATE TABLE document_deliveries (
    job_id      TEXT PRIMARY KEY,
    business_id TEXT        NOT NULL,
    card_id     TEXT        NOT NULL,
    version_id  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX document_deliveries_business_card_idx ON document_deliveries (business_id, card_id);
