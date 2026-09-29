-- Which vendor's API implements this system today. Operational, like
-- `endpoint` beside it: the charter decides whether the system exists, on
-- which channel, and which tools it serves -- this only says whose code runs.
-- Nullable: a connection served by an env-configured adapter (the mail
-- transport) has no provider, and must keep working untouched.
ALTER TABLE connection_bindings ADD COLUMN provider TEXT;
