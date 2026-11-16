-- The panel's own unknown-login bucket.
--
-- `staffLogin` pays a decoy scrypt for an address that is not a live,
-- redeemed staff member, so "no such member" and "wrong password" cannot be
-- told apart by timing. Nothing bounded that: anyone who reaches the panel
-- port could make it spend scrypt without limit. The owner's dashboard solved
-- the same problem with `dashboard_unknown_user_throttle` (010, made one row
-- by 066); this is the same shape, and a SEPARATE row on purpose — probing
-- the panel must not lock owners out of the dashboard, and probing the
-- dashboard must not lock technicians out of the panel.
--
-- One row, not one per submitted address: a random address does not make a
-- row, and a real member's failures go to their own platform_staff row, so
-- this bucket can never lock a real member.
CREATE TABLE platform_staff_unknown_login_throttle (
    singleton        BOOLEAN     PRIMARY KEY DEFAULT true CHECK (singleton),
    failed_attempts  INTEGER     NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until     TIMESTAMPTZ
);

-- A server table: the app account has no business here (062's default
-- privileges granted it DML), the platform group does — the pattern 072 uses.
REVOKE ALL ON platform_staff_unknown_login_throttle FROM assistant_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_staff_unknown_login_throttle TO assistant_platform_group;
