-- The owner's signature on a document
-- (docs/superpowers/specs/2026-09-01-signature-design.md §5).
--
-- This is a record in the system, not a cryptographic signature and not an
-- edit to the file. It says: this person, at this time, through this approval,
-- accepted the document whose bytes hashed to exactly this.
--
-- `signed_sha256` is measured AT SIGNING TIME by re-reading the stored file,
-- not copied from `documents.sha256`. The two agreeing is what the signing
-- path checks; recording the intake hash instead would make the row attest to
-- a file nobody re-examined.
--
-- One signature per document. A second is not an update — it is a sign that
-- something in the flow is unclear, and it fails loudly.
CREATE TABLE signatures (
    signature_id  TEXT        PRIMARY KEY,
    business_id   TEXT        NOT NULL,
    document_id   TEXT        NOT NULL REFERENCES documents (document_id) ON DELETE CASCADE,
    signed_sha256 TEXT        NOT NULL,
    approval_id   TEXT        NOT NULL,
    -- A dashboard username. Never an agent id, never 'system'.
    signed_by     TEXT        NOT NULL,
    signed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX signatures_one_per_document_idx
    ON signatures (business_id, document_id);
