-- The model's raw response text, kept on every proposal row.
--
-- `ProposeOutcome` (src/sdk/proposer.ts) already carries `raw` on both the
-- `proposed` and `unproposable` branches -- it is the evidence a stored
-- `unproposable` reason rests on, and the composition just never wrote it
-- down. Without this column a schema rejection on the live model
-- ("Invalid option: expected one of ...") could only be diagnosed by
-- inference: the row records the reason, never what the model actually said.
--
-- Stored on `proposed` rows too, not only the failures. A cheap successful
-- row is what lets a later failure be read against a known-good example from
-- the same prompt version, and withholding it there would make "what does a
-- good response look like" a question with no answer on file.
ALTER TABLE proposals
    ADD COLUMN raw TEXT NOT NULL DEFAULT '';

ALTER TABLE proposals
    ALTER COLUMN raw DROP DEFAULT;
