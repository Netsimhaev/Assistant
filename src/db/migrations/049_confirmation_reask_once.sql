-- 049_confirmation_reask_once.sql
--
-- Boss command (spec 2026-10-28, §10.3): a confirmed command whose run went
-- wrong after the confirmation is asked again, ONCE per job. The re-ask is a
-- new job with a new `instruction_confirmations` row whose `reask_of` names
-- the old job, and this index is what makes "once" a fact of the schema
-- rather than of the sweep's read: two scheduler passes racing on the same
-- old job can both decide to re-ask it, and only one INSERT of a row naming
-- it can land (`command-reask.ts`).
--
-- A new migration, not an edit of 048: the runner tracks by file name, so an
-- edit in place would leave every database that already ran 048 without it.
CREATE UNIQUE INDEX instruction_confirmations_reask_once
  ON instruction_confirmations (business_id, reask_of)
  WHERE reask_of IS NOT NULL;
