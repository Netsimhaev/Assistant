-- Signatures outlive the documents they attest to, and their hash has a shape.
-- (final review, findings F4.)
--
-- 019 declared `document_id ... ON DELETE CASCADE`, which ties the lifetime of
-- the one row recording a human act to the lifetime of the thing that act was
-- about. Nothing deletes from `documents` today, so this was latent — but
-- retention windows and erasure requests are ordinary futures, and the first
-- purge would have taken the evidence with the evidence's subject. RESTRICT is
-- the "evidence survives" choice: a document that someone accepted as binding
-- cannot be deleted out from under its signature, and whoever wants it gone
-- has to decide about the signature explicitly.
--
-- Written as a new migration rather than an edit to 019: the runner tracks
-- applied migrations by filename, so editing 019 in place would leave every
-- database that already ran it on CASCADE while the file on disk claimed
-- otherwise — schema drift that reads as if it had been fixed.

ALTER TABLE signatures
    DROP CONSTRAINT signatures_document_id_fkey;

ALTER TABLE signatures
    ADD CONSTRAINT signatures_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES documents (document_id) ON DELETE RESTRICT;

-- The format check the other hash columns already carry (`audit_log`'s
-- `audit_hash_is_sha256`, 001_spine.sql). `signed_sha256` is the whole point
-- of the row; a truncated, upper-cased or empty value stored here would still
-- compare unequal to a real hash forever after, and the row would go on
-- looking like a signature.
ALTER TABLE signatures
    ADD CONSTRAINT signature_sha256_is_sha256 CHECK (signed_sha256 ~ '^[0-9a-f]{64}$');
