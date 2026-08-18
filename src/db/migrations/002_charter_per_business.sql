-- Scope charter versions to their business.
--
-- 001 made `charter_version` a global primary key. Two businesses both naming
-- their first charter "v1" collided on insert, and `loadActiveCharter` joined
-- `charter_active` to `charter_versions` on the version string alone — so it
-- could return another business's charter. Every other table in the schema is
-- already keyed by business_id; this brings the charter tables in line.
--
-- Three foreign keys point at the old single-column key and all three have to
-- be rebuilt as composite. `jobs` is the one that is easy to miss: it is not a
-- charter table, but it pins each job to the charter it ran under, and that
-- pin has to name a business too or a job could cite another business's rules.

ALTER TABLE charter_active   DROP CONSTRAINT charter_active_charter_version_fkey;
ALTER TABLE jobs             DROP CONSTRAINT jobs_charter_version_fkey;
ALTER TABLE charter_versions DROP CONSTRAINT charter_versions_supersedes_fkey;
ALTER TABLE charter_versions DROP CONSTRAINT charter_versions_pkey;

ALTER TABLE charter_versions
    ADD CONSTRAINT charter_versions_pkey PRIMARY KEY (business_id, charter_version);

-- A charter may only supersede an earlier charter of the same business.
ALTER TABLE charter_versions
    ADD CONSTRAINT charter_versions_supersedes_fkey
    FOREIGN KEY (business_id, supersedes)
    REFERENCES charter_versions (business_id, charter_version);

ALTER TABLE charter_active
    ADD CONSTRAINT charter_active_charter_version_fkey
    FOREIGN KEY (business_id, charter_version)
    REFERENCES charter_versions (business_id, charter_version);

ALTER TABLE jobs
    ADD CONSTRAINT jobs_charter_version_fkey
    FOREIGN KEY (business_id, charter_version)
    REFERENCES charter_versions (business_id, charter_version);
