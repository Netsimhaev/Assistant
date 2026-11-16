-- 070_owner_second_factor.sql
--
-- The owner's second factor (Google Authenticator, RFC 6238) and the devices
-- that may skip it for thirty days. Replaces the recovery codes.
--
-- * dashboard_users.totp_* — the secret is sealed with the master key
--   (`encryptSecret`, AAD `{ businessId, ref: 'totp:<username>' }`); both
--   halves are null until enrolment begins, and never one without the other.
--   `totp_enrolled_at` null with a sealed secret is a pending enrolment.
--   `totp_last_step` is the last accepted 30-second step: a code at or below
--   it is a replay. The failure counter and lock mirror the password's.
-- * dashboard_sessions.pending_factor — a session that still owes its second
--   factor ('enroll' or 'verify'); null is a full session.
-- * dashboard_trusted_devices — the sha256 of a random cookie token, never the
--   token, per (business, device).
--
-- dashboard_recovery_codes is dropped at deploy, not at each owner's next
-- login: the redemption path is gone with this migration's code, so the codes
-- would be inert anyway. A technician reset link replaces them.
--
-- Migration 068 does not cover tables added after it, so RLS is enabled here.

ALTER TABLE dashboard_users
    ADD COLUMN totp_ciphertext      bytea,
    ADD COLUMN totp_nonce           bytea,
    ADD COLUMN totp_enrolled_at     timestamptz,
    ADD COLUMN totp_last_step       bigint,
    ADD COLUMN totp_failed_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN totp_locked_until    timestamptz,
    ADD CONSTRAINT dashboard_users_totp_sealed_pair
        CHECK ((totp_ciphertext IS NULL) = (totp_nonce IS NULL)),
    ADD CONSTRAINT dashboard_users_totp_enrolled_has_secret
        CHECK (totp_enrolled_at IS NULL OR totp_ciphertext IS NOT NULL);

ALTER TABLE dashboard_sessions
    ADD COLUMN pending_factor text
        CHECK (pending_factor IN ('enroll', 'verify'));

CREATE TABLE dashboard_trusted_devices (
    business_id text        NOT NULL,
    device_hash text        NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
    username    text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz,
    PRIMARY KEY (business_id, device_hash)
);

CREATE INDEX dashboard_trusted_devices_user
    ON dashboard_trusted_devices (business_id, username);

ALTER TABLE dashboard_trusted_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_trusted_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dashboard_trusted_devices
    USING (business_id = app_business_id())
    WITH CHECK (business_id = app_business_id());

DROP TABLE dashboard_recovery_codes;
