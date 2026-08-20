-- A recovery-code login must force a password change before anything else on
-- the dashboard is reachable. The flag lives on the session, not on
-- dashboard_users: redeemRecoveryCode already revokes every open session on
-- redemption, so the one session minted right after it (by
-- src/dashboard/auth.ts's startSession) is the only row that needs to carry
-- it. setPassword's own blanket session revoke clears it again for free —
-- the session that required a change never survives a password change, and
-- the fresh session issued afterwards is minted with the flag unset.
ALTER TABLE dashboard_sessions
    ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
