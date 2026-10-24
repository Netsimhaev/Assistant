-- The provider the owner chose at the start of a consent ceremony (mailbox:
-- google or microsoft), carried on the single-use state row so the callback
-- reads it from the stored row and never from the query string. Nullable:
-- ceremonies for systems with a single provider (calendar) leave it NULL.
ALTER TABLE oauth_states ADD COLUMN provider TEXT;
