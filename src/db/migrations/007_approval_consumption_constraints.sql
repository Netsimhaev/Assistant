-- Add foreign keys from dashboard session and recovery code tables back to dashboard_users.
--
-- Removing an owner is a deliberate local operation, and sessions and recovery codes
-- belonging to a deleted account must not survive it. ON DELETE CASCADE ensures that
-- deleting a dashboard_users row also removes all sessions and recovery codes for that
-- account, keeping the tables mutually consistent.
ALTER TABLE dashboard_sessions
    ADD CONSTRAINT dashboard_sessions_owner_fk
        FOREIGN KEY (business_id, username)
        REFERENCES dashboard_users (business_id, username)
        ON DELETE CASCADE;

ALTER TABLE dashboard_recovery_codes
    ADD CONSTRAINT dashboard_recovery_codes_owner_fk
        FOREIGN KEY (business_id, username)
        REFERENCES dashboard_users (business_id, username)
        ON DELETE CASCADE;

-- Approval consumption columns must be paired: both null (unspent) or both set (spent).
--
-- The column's stated purpose is recording which step spent an approval. A row with
-- a consumption time and no step defeats exactly that. This constraint ensures the
-- audit trail is complete: if consumed_at is set, the step that consumed it must be
-- recorded, and vice versa.
ALTER TABLE approval_requests
    ADD CONSTRAINT approval_consumption_both_or_neither
        CHECK (
            (consumed_at IS NULL AND consumed_by_step IS NULL)
            OR
            (consumed_at IS NOT NULL AND consumed_by_step IS NOT NULL)
        );
