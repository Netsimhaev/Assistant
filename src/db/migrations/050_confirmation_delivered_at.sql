-- 050_confirmation_delivered_at.sql
--
-- Boss command: a WhatsApp confirmation question counts as presented only
-- once it was DELIVERED. `presented_at` is written at INSERT, before the send
-- — so a question whose send failed (gateway not connected, provider error,
-- or a question too long for one WhatsApp message) still looked presented,
-- and a later "כן" on WhatsApp confirmed a plan the owner never saw, past
-- gate stages 5–9 (final review of 28/10, I1).
--
-- `delivered_at` is stamped only after an `ok` send, and every WhatsApp
-- confirm path (`openConfirmations`, `confirmChoice` with an inbound
-- timestamp) requires it — strict-after is measured from it, not from
-- `presented_at`. The dashboard renders the row itself, so a dashboard
-- confirm needs no delivery, and an undelivered WhatsApp row stays listed and
-- confirmable there.
--
-- No backfill: a pending WhatsApp row from before this migration reads as
-- undelivered, which closes it to WhatsApp answers and leaves it on the
-- dashboard — the direction that can only refuse. Pending rows live inside
-- the question window (30 minutes by default) in any case.
--
-- The CHECK keeps the column meaningful: only a WhatsApp question is
-- delivered by sending. Holds no content, so erasure is unaffected.
--
-- A new migration, not an edit of 048: the runner tracks by file name.
ALTER TABLE instruction_confirmations
  ADD COLUMN delivered_at TIMESTAMPTZ;

ALTER TABLE instruction_confirmations
  ADD CONSTRAINT instruction_confirmations_delivered_whatsapp_only
  CHECK (delivered_at IS NULL OR channel = 'whatsapp');
