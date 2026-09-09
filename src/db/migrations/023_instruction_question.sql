-- 023_instruction_question.sql
--
-- The clarifying question the planner asked, kept beside the instruction that
-- provoked it.
--
-- Until now it existed in exactly one place: the HTML of the POST response
-- that created it. Reload the page, navigate away or close the tab, and the
-- job sat in `understand` — a phase nothing in the scheduler touches — with
-- no way for the owner to ever see what they were being asked. A question the
-- owner cannot re-read is a question they cannot answer.
--
-- A column on `boss_instructions` rather than a table of its own: there is at
-- most one open question per instruction, because `runInstruction` returns at
-- the first one and the row is keyed `job_id UNIQUE`. A second question is a
-- second run over the joined text, which is a second instruction row on a
-- second job.
--
-- Nullable, and deliberately not backfilled. NULL means "no question was
-- asked" for every instruction that planned cleanly, and it also means "asked
-- before this migration existed" for any job already parked — those cannot be
-- recovered, and inventing text for them would be worse than an empty answer
-- box. `pendingQuestions` filters on the phase and on `answer IS NULL`, never
-- on this column, so such a job still appears and can still be answered.

ALTER TABLE boss_instructions ADD COLUMN question TEXT;

-- The same bound the instruction and the answer already live under. A question
-- is model output, and model output that can grow without limit is a storage
-- bound nobody set.
ALTER TABLE boss_instructions
  ADD CONSTRAINT boss_instructions_question_bounded
  CHECK (question IS NULL OR length(question) <= 4000);
