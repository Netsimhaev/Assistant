-- 039_instruction_text_origin.sql
--
-- Where an instruction's bytes came from: the owner's own keyboard, or a
-- transcription provider's model reading his recording.
--
-- 022's own comment on `text` says "Verbatim, as typed. Never reformatted:
-- the recipient rule in `authorisedRecipients` matches against exactly these
-- bytes." That sentence was true when the dashboard form was the only door.
-- The WhatsApp channel added a second one, and a voice note's text is not
-- typed by anyone — it is model output from a third party. The rule that
-- reads these bytes grants a STANDING AUTHORISATION on the strength of "the
-- owner typed this address himself", and the whole system rests on authority
-- never being derivable from content. A transcript is content.
--
-- **Why a column, and not derived at read time from the linked WhatsApp
-- message.** `jobs.whatsapp_message_id` plus `whatsapp_messages.media_kind`
-- could, today, answer "did this instruction arrive as a recording" for a
-- job the door opened. Three reasons that derivation is the wrong one. It is
-- a join across two modules for a fact one row can simply state. It breaks
-- the moment a third door exists (an email instruction, an SMS one) with no
-- WhatsApp row to join to — and silently, in the permissive direction, since
-- a missing row reads as "not a recording". And it would tie the fact's
-- lifetime to a row the erasure path destroys on its own schedule:
-- `executeErasure` (src/governance/erasure.ts) deletes `whatsapp_messages`
-- by its own predicate, so "did this arrive as a recording" would be a
-- question whose answer can disappear while the instruction it describes is
-- still there to be read.
--
-- **Backfilled to 'typed', with no DEFAULT left behind, and both halves of
-- that are deliberate.** Every row that can exist when this migration runs
-- was written through the dashboard's instruction box: the WhatsApp door
-- exists only on this branch, is wired to no real gateway, and no
-- transcription provider is connected to any installation — so 'typed' is
-- the true value for every existing row, not a convenient guess. But a
-- DEFAULT would stay behind forever as a permissive fallback: a future writer
-- that forgot the column would silently produce a row claiming the owner
-- typed it. `NOT NULL` with no default makes that omission a loud insert
-- failure instead, which is the direction this project takes everywhere a
-- value decides authority.
--
-- New file, never an edit to 022: the migration runner tracks applied
-- migrations by filename (`src/db/migrate.ts`), so editing 022 in place would
-- leave every database that already ran it without the column while the file
-- on disk claimed otherwise — the same reasoning 037 and 038 each give for
-- not editing 036.

ALTER TABLE boss_instructions ADD COLUMN text_origin TEXT;

UPDATE boss_instructions SET text_origin = 'typed' WHERE text_origin IS NULL;

ALTER TABLE boss_instructions ALTER COLUMN text_origin SET NOT NULL;

-- Closed, named values — the SQL half of the TypeScript union
-- (`InstructionTextOrigin`, src/governance/typed-recipients.ts). A third
-- origin tomorrow has to be added here on purpose, in the open, rather than
-- arriving as an unrecognised string that the reader below would have to
-- decide what to do with.
ALTER TABLE boss_instructions
  ADD CONSTRAINT boss_instructions_text_origin_check
  CHECK (text_origin IN ('typed', 'transcribed'));
