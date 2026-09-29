-- Corrects 032: `oauth_grants_by_ref` must be partial (`WHERE revoked_at IS
-- NULL`), matching the precedent 024_memories.sql already set with
-- `memories_live_entity_idx` / `memories_live_preference_idx`. Revocation is
-- soft -- the row stays, on purpose -- so an unconditional unique index on
-- (business_id, credential_ref) would let a revoked grant occupy its ref
-- forever: a system renamed or re-pointed to that same ref after being
-- revoked would die on a raw Postgres unique-violation instead of a
-- readable refusal from the application.
--
-- A NEW migration, not an edit to 032 in place: the runner
-- (`src/db/migrate.ts`) tracks which migrations ran by filename alone, with
-- no content hash. Editing 032's `CREATE UNIQUE INDEX` in place would leave
-- any database that already applied 032 stuck with the old, unconditional
-- index while the file on disk claimed the corrected one -- exactly the
-- "the file says one thing, the database another" gap a migration history
-- exists to rule out.
DROP INDEX oauth_grants_by_ref;

CREATE UNIQUE INDEX oauth_grants_by_ref
    ON oauth_grants (business_id, credential_ref)
    WHERE revoked_at IS NULL;
