-- The master key belongs to the server, so its key state is the one row in
-- `server_key_state` (spec §5.9), and `credential_key_state` — one row per
-- business, from when an installation served one — goes.
--
-- **The check value of a carried-over row stays sealed for its old business.**
-- `master-key.ts` seals the key check under the authenticated data
-- `{ businessId, ref: 'key-check' }`, and a row written before this migration
-- was sealed under the business the installation was configured for. Moving the
-- row does not re-seal it (that needs the key, which a migration never holds),
-- so the business it was sealed under travels with it in `check_business_id`.
-- A row the server writes from now on is sealed under `''` — a value no
-- business id (`^[a-z0-9-]{3,63}$`) can take — and the next `rotate` or
-- `create` replaces the carried-over row with one of those.
ALTER TABLE server_key_state
    ADD COLUMN check_business_id TEXT NOT NULL DEFAULT '';

-- 064 copied the one business row across, but nothing wrote `server_key_state`
-- between 064 and now: a rotation in that window moved `credential_key_state`
-- only. So the copy is taken again, from the row the code was still using.
DO $$
DECLARE
    business_rows integer;
BEGIN
    SELECT count(*) INTO business_rows FROM credential_key_state;
    IF business_rows = 1 THEN
        DELETE FROM server_key_state;
        INSERT INTO server_key_state (singleton, key_id, check_nonce, check_value, created_at, check_business_id)
        SELECT true, key_id, check_nonce, check_value, created_at, business_id
          FROM credential_key_state;
    ELSIF business_rows > 1 AND NOT EXISTS (SELECT 1 FROM server_key_state) THEN
        -- Two key states and no server row: which key is "the server's" is a
        -- guess, and dropping the table would lose both. Refused, loudly.
        RAISE EXCEPTION 'credential_key_state holds % rows and server_key_state none — pick the server key by hand before migrating', business_rows;
    END IF;
END $$;

DROP TABLE credential_key_state;
