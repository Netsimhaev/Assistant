-- 041_digest_drop_screen_at.sql
--
-- `digests.screen_at` (040_digest.sql) is a column with no reader: it appears
-- in exactly two places in the whole repository before this migration — the
-- CREATE TABLE that added it and the INSERT in `digest-store.ts` that wrote
-- `now()` into it, unconditionally, on every insert. It is never SELECTed, it
-- is not on `StoredDigest`, and the design spec never mentions it. Worse than
-- dead weight: a nullable timestamp named `screen_at` invites the next reader
-- to believe it records when the OWNER saw the digest — a fact nothing in
-- this system tracks. Keeping it would be a lie waiting to be believed, the
-- same class of defect CLAUDE.md already lists five instances of.
--
-- Written as a new migration rather than an edit to 040: the runner tracks
-- applied migrations by filename, so editing 040 in place would leave every
-- database that already ran it (dev and test both have) silently disagreeing
-- with the file on disk. 020_signature_evidence.sql exists for exactly this
-- reason, over the same kind of mistake with 019.

ALTER TABLE digests
    DROP COLUMN screen_at;
