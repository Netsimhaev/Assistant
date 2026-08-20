-- Recovery-code redemption gets its own throttle, separate from password
-- login's failed_attempts/locked_until.
--
-- A lockout protects a *low-entropy* secret from repeated guessing. A
-- recovery code is 128 random bits: it cannot be guessed at any rate, so
-- spending the password's budget on it buys no security whatsoever, and
-- pays for it in availability twice over -- once as a hole (anyone who
-- knows the username can re-lock password login every fifteen minutes with
-- five wrong codes, effectively for free) and once as a trap (an owner who
-- mistypes their password five times is then also unable to use the
-- recovery codes that exist for exactly that moment). Recovery needs a cap
-- of its own for a different reason entirely: each attempt costs up to
-- eight scrypt calls, and an endpoint that will run that on demand,
-- unthrottled, is a CPU-exhaustion vector. That is what these columns
-- limit -- not guessing, which the code's entropy already makes impossible.
ALTER TABLE dashboard_users
    ADD COLUMN recovery_failed_attempts INTEGER     NOT NULL DEFAULT 0,
    ADD COLUMN recovery_locked_until    TIMESTAMPTZ;
