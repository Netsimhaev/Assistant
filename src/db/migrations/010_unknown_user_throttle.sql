-- A throttle for usernames that have no dashboard_users row.
--
-- Both authentication paths counted failures with an UPDATE against
-- dashboard_users. For a username that does not exist, that UPDATE matches
-- nothing: the counter never moved, the lockout never engaged, and the
-- endpoint would run its work on demand, unbounded. Recovery redemption is
-- the expensive one -- up to eight scrypt calls per request, including the
-- decoy calls paid precisely so an unknown username costs the ATTACKER what
-- a real one does. That property is worth keeping; what is not acceptable is
-- that it also costs the SERVER the same, forever, to an unauthenticated
-- caller. Starving the box is starving the owner's only way to answer an
-- approval.
--
-- The counter needs somewhere to live when there is no user row to hold it.
-- It lives here, in ONE row per business, shared by every username that does
-- not exist. That choice is deliberate on two counts:
--
--   * Bounded. Keyed by the submitted username instead, an attacker writes
--     one row per random string and the throttle becomes a way to fill the
--     disk.
--   * Cannot be turned against the owner. The real account's failures still
--     go to its own dashboard_users row, so no amount of traffic aimed at
--     names that do not exist can lock out the name that does. An attacker
--     exhausting this bucket only stops other nonexistent-username traffic
--     -- which is exactly the traffic we want stopped.
--
-- What it does leak: once the bucket is locked, an unknown username refuses
-- cheaply while a real one still pays the full cost, so response time can
-- distinguish them again. That is the same trade the per-user lock already
-- makes (a locked account is answered before any hash is computed), and it
-- is unavoidable -- a throttle that still pays the cost is not a throttle.
-- On a single-tenant install created by a local CLI command, the username is
-- close to public anyway; the secret this defends is the code, not the name.
--
-- Column names mirror dashboard_users so the two budgets stay separate for
-- the same reason they are separate there: a lockout protects a low-entropy
-- secret from guessing, and recovery codes are 128 random bits. The recovery
-- cap exists to bound CPU, not to stop guessing.
CREATE TABLE dashboard_unknown_user_throttle (
    business_id               TEXT PRIMARY KEY,
    failed_attempts           INTEGER     NOT NULL DEFAULT 0,
    locked_until              TIMESTAMPTZ,
    recovery_failed_attempts  INTEGER     NOT NULL DEFAULT 0,
    recovery_locked_until     TIMESTAMPTZ
);
