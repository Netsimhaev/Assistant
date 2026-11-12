-- Who last wrote each server secret. `platform_credentials` belongs to no
-- business, so `audit_log` (a chain per business) cannot record it; this
-- column is the trace `secret --platform put` leaves instead. Rows written
-- before it existed are backfilled as 'unknown' — the honest answer.
ALTER TABLE platform_credentials ADD COLUMN updated_by TEXT;
UPDATE platform_credentials SET updated_by = 'unknown' WHERE updated_by IS NULL;
ALTER TABLE platform_credentials ALTER COLUMN updated_by SET NOT NULL;
