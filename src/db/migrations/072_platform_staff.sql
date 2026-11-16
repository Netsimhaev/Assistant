-- 072_platform_staff.sql
--
-- The company's technicians, who sign in to the operator panel — and the log
-- of what they did there. These are the SERVER's tables, not a business's:
-- no `business_id` (the activity log's `business_id` names the business an
-- action touched, it does not scope the row), no row-level security, and the
-- GRANTs are the whole control — the same pattern 064/068 use for
-- `platform_credentials` and `server_key_state`.
--
-- * platform_staff — one row per staff member. `login` is the address they
--   sign in with, stored normalised and unique. The password is null until
--   the invite link is redeemed. The second factor mirrors 070's owner
--   columns: the secret is sealed with the master key (AAD
--   `{ businessId: '', ref: 'staff-totp:<staffId>' }`), `totp_last_step` is
--   the last accepted step, and the lock counters mirror the password's.
--   `removed_at` retires a member; the row stays, so the activity log keeps
--   naming who did what.
-- * platform_staff_sessions / _devices / _links — only the sha256 of each
--   token is stored, never the token.
-- * platform_activity_log — append-only: nobody but the migrator may UPDATE
--   or DELETE it. `detail` carries counts and flags, never business content.

CREATE TABLE platform_staff (
    staff_id             text        PRIMARY KEY,
    login                text        NOT NULL CHECK (length(login) > 0),
    display_name         text        NOT NULL CHECK (length(display_name) > 0),
    password_hash        text,
    password_salt        text,
    is_head              boolean     NOT NULL DEFAULT false,
    totp_ciphertext      bytea,
    totp_nonce           bytea,
    totp_enrolled_at     timestamptz,
    totp_last_step       bigint,
    failed_attempts      integer     NOT NULL DEFAULT 0,
    locked_until         timestamptz,
    totp_failed_attempts integer     NOT NULL DEFAULT 0,
    totp_locked_until    timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    removed_at           timestamptz,
    CONSTRAINT platform_staff_password_pair
        CHECK ((password_hash IS NULL) = (password_salt IS NULL)),
    CONSTRAINT platform_staff_totp_sealed_pair
        CHECK ((totp_ciphertext IS NULL) = (totp_nonce IS NULL)),
    CONSTRAINT platform_staff_totp_enrolled_has_secret
        CHECK (totp_enrolled_at IS NULL OR totp_ciphertext IS NOT NULL)
);

CREATE UNIQUE INDEX platform_staff_login_unique ON platform_staff (lower(login));

CREATE TABLE platform_staff_sessions (
    session_hash   text        PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
    staff_id       text        NOT NULL REFERENCES platform_staff (staff_id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    revoked_at     timestamptz,
    pending_factor text        CHECK (pending_factor IN ('enroll', 'verify'))
);

CREATE INDEX platform_staff_sessions_staff ON platform_staff_sessions (staff_id);

CREATE TABLE platform_staff_devices (
    device_hash text        PRIMARY KEY CHECK (device_hash ~ '^[0-9a-f]{64}$'),
    staff_id    text        NOT NULL REFERENCES platform_staff (staff_id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz
);

CREATE INDEX platform_staff_devices_staff ON platform_staff_devices (staff_id);

CREATE TABLE platform_staff_links (
    link_hash  text        PRIMARY KEY CHECK (link_hash ~ '^[0-9a-f]{64}$'),
    staff_id   text        NOT NULL REFERENCES platform_staff (staff_id),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    issued_by  text        NOT NULL REFERENCES platform_staff (staff_id)
);

CREATE INDEX platform_staff_links_staff ON platform_staff_links (staff_id);

CREATE TABLE platform_activity_log (
    seq         bigserial   PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    staff_id    text        NOT NULL REFERENCES platform_staff (staff_id),
    action      text        NOT NULL,
    business_id text,
    detail      jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object')
);

-- Migration 062's default privileges gave `assistant_app` DML on every new
-- table and USAGE on every new sequence. A business connection has no reason
-- to reach any of these, so all of it is taken back. The platform login also
-- belongs to `assistant_app`; it gets its privileges through
-- `assistant_platform_group` instead, as for the server's other tables (068).
REVOKE ALL ON platform_staff, platform_staff_sessions, platform_staff_devices,
              platform_staff_links, platform_activity_log
  FROM assistant_app;
REVOKE ALL ON SEQUENCE platform_activity_log_seq_seq FROM assistant_app;

GRANT SELECT, INSERT, UPDATE, DELETE
   ON platform_staff, platform_staff_sessions, platform_staff_devices,
      platform_staff_links, platform_activity_log
   TO assistant_platform_group;
GRANT USAGE ON SEQUENCE platform_activity_log_seq_seq TO assistant_platform_group;

-- The activity log is append-only for every runtime account.
REVOKE UPDATE, DELETE ON platform_activity_log FROM assistant_platform_group;
