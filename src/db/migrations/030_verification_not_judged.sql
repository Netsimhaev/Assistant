-- A verification that was attempted and could not complete is a different fact
-- from a verification that never started, and the card must tell them apart:
-- with no row at all meaning "still running", the absence of a row could
-- otherwise mean either "still running" or "gave up", at different times, with
-- nothing to distinguish them on screen.
--
-- Exactly one of the two columns is populated, enforced here rather than only
-- in TypeScript: `saveVerdict` and `saveNotJudged` both upsert on the same
-- primary key, and a future caller that forgets to clear the other column
-- would otherwise write a row claiming both at once.
ALTER TABLE verification_verdicts ALTER COLUMN verdict DROP NOT NULL;
ALTER TABLE verification_verdicts ADD COLUMN not_judged_reason TEXT;

ALTER TABLE verification_verdicts ADD CONSTRAINT verification_verdicts_one_shape
    CHECK (
        (verdict IS NOT NULL AND not_judged_reason IS NULL)
     OR (verdict IS NULL AND not_judged_reason IN ('failed', 'timeout'))
    );
