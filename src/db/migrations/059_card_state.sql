-- 059_card_state.sql
--
-- `fix_requested` was a card state nothing ever wrote: a fix request moves
-- the card to `superseded` (`requestFix`, `production/card.ts`) and the new
-- version gets a card of its own. A state no code writes is a state no
-- reader can be trusted to handle, so the CHECK stops admitting it.
-- A new migration and not an edit of 053: the runner is keyed by file name.
ALTER TABLE document_cards DROP CONSTRAINT document_cards_state_known;
ALTER TABLE document_cards
  ADD CONSTRAINT document_cards_state_known
    CHECK (state IN ('open','approved','saved','superseded','failed_send'));
