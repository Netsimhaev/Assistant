-- The anti-forgery gate for the OAuth consent ceremony (dashboard oauth
-- routes). Single-use, session-bound, short-lived. Without this table the
-- `state` parameter is just a string the browser hands back on the redirect,
-- and anyone who can make the owner's browser complete an authorisation flow
-- can bind THEIR OWN provider account to this business -- the owner approves
-- what looks like an ordinary consent screen and sees nothing unusual.
--
-- `code_verifier` rides along on the same row, never separately: PKCE is not
-- required here (the app secret lives server-side), but it is cheap and it
-- is the one control that still stands if an authorisation code leaks from
-- browser history or a proxy log (spec 5.2).
--
-- Erasure decision, per the convention migration 026 set: excluded,
-- deliberately, and for the same reason `oauth_grants` (migration 032) is.
-- A row here is a fact about one in-flight authorisation attempt by the
-- business's own owner -- not about a counterparty -- and it is gone within
-- minutes either way (consumed, or expired). There is nothing here for a
-- "forget me" request to reach.
CREATE TABLE oauth_states (
    state         TEXT PRIMARY KEY,
    business_id   TEXT NOT NULL,
    system        TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ
);

-- `consumeState` claims a row by `state` alone (its primary key already
-- serves that lookup); this index serves the other direction -- scoping a
-- claim to `business_id` without a sequential scan on a table that a
-- misbehaving client could otherwise grow without bound.
CREATE INDEX oauth_states_business_idx ON oauth_states (business_id);
