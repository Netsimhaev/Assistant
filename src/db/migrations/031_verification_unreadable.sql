-- A third way a verification ends without a verdict: the helper answered, and
-- what it answered with cannot be read.
--
-- `failed` and `timeout` (030) are both about the delegation. This one is not:
-- the child job completed and the `result` envelope says `succeeded`, but the
-- reading it produced carries no content — `know.reader` returns
-- `{ performed: true, status: 'unreadable' }` for a document it could not read,
-- and that is a successful delegation whose answer is empty.
--
-- Without this value the judging step had nothing to file and refused instead,
-- which meant every unreadable document left its card reading "still running"
-- forever — the exact ambiguity 030 exists to remove, reintroduced one state
-- further along.
--
-- A NEW MIGRATION, not an edit to 030: the runner tracks migrations by
-- filename, so editing 030 in place would leave every database that already
-- ran it on the two-value constraint while the file on disk claimed three.
ALTER TABLE verification_verdicts DROP CONSTRAINT verification_verdicts_one_shape;

ALTER TABLE verification_verdicts ADD CONSTRAINT verification_verdicts_one_shape
    CHECK (
        (verdict IS NOT NULL AND not_judged_reason IS NULL)
     OR (verdict IS NULL AND not_judged_reason IN ('failed', 'timeout', 'unreadable'))
    );
