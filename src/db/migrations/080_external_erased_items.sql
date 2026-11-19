-- 080_external_erased_items.sql
--
-- Stage D final review (I3): a tombstone for every external event an erasure
-- removed. Deleting `external_events` also deleted its `item_hash` dedupe row,
-- and the provider still holds the record — so the next scan or alert carried
-- the same item in again, and learning wrote the erased person back into
-- memory. `insertEvent` now refuses an item whose (system, item hash) is here.
--
-- Hashes only — no content, nothing about a person: an item hash is a digest
-- of what the provider delivered, and the table cannot answer "who" without
-- the content that was erased. It is therefore not a discovery source, not an
-- erasure target, and not counted among the erased tables.
--
-- A record the provider later CHANGES hashes differently and is stored again.
-- That is stated to the owner on the erasure preview.

CREATE TABLE external_erased_items (
    business_id text        NOT NULL,
    system_id   text        NOT NULL,
    item_hash   text        NOT NULL,
    erased_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, system_id, item_hash)
);

ALTER TABLE external_erased_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_erased_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_erased_items
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());
