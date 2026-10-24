-- Final-review hardening for the mailbox connection.
--
-- 1. oauth_states.provider is a closed set. The callback reads the provider
--    from this row and never from the query string (043), so the row is the
--    one place a value outside google/microsoft must be refused. NULL stays
--    legal: ceremonies with a single provider (calendar) leave it NULL, and
--    rows written before 043 carry NULL too. Checked before this migration:
--    no existing row on the dev or test databases carried any other value.
--    NOT VALID would skip the existing rows; it is not used, so an install
--    that somehow holds a bad row fails here loudly rather than keeping it.
ALTER TABLE oauth_states
  ADD CONSTRAINT oauth_states_provider_known
  CHECK (provider IS NULL OR provider IN ('google', 'microsoft'));

-- 2. The mailbox-reply-job marker (`isMailReplyJob`, `openMailCards`, and the
--    stage-8 exemption's EXISTS in `approvedReplyCovers`, which runs on every
--    gate check of an email.reply) looks mail up by (business_id,
--    reply_job_id). Partial: most mail never gets a reply job.
CREATE INDEX mail_messages_reply_job_idx
  ON mail_messages (business_id, reply_job_id)
  WHERE reply_job_id IS NOT NULL;

-- 3. The triage-job lookup (`mailForJob`, curation scope, erasure by job).
CREATE INDEX mail_messages_job_idx ON mail_messages (business_id, job_id);
