-- `agent_envelopes_child_idx` (028) was not unique, and `loadEnvelopeForChildJob`
-- (`governance/envelope-store.ts`) reads `rows[0]` with no `ORDER BY` — two
-- envelopes naming the same child would hand the gate a nondeterministic
-- `autonomyCeiling`. A child job is opened by exactly one delegation
-- (`requestHelp` calls `attachChildJob` exactly once, on the one envelope it
-- just wrote), so the constraint the code already assumes is made real here.
--
-- A new migration, not an edit to 028: the runner tracks migrations by
-- filename, and editing 028 in place would leave any database that already
-- ran it on the old, non-unique index while the file on disk claimed
-- otherwise.
DROP INDEX agent_envelopes_child_idx;

CREATE UNIQUE INDEX agent_envelopes_child_idx
    ON agent_envelopes (business_id, child_job_id) WHERE child_job_id IS NOT NULL;
