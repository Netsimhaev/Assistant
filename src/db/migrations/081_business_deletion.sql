-- 081_business_deletion.sql
--
-- The database half of deleting a whole business (spec 2026-11-19, plan
-- Task 1): a status for a deletion whose file step is unfinished, the
-- scheduler's per-business pass heartbeat, the one actor `audit_log` lets
-- delete, and the function that deletes one business's rows from every table.

-- ---------------------------------------------------------------------------
-- The registry.
--
-- `deleting`: the rows are gone and the files are not yet (plan Ruling 5). The
-- registry row stays until every file is gone, so the head admin can retry.
-- The pass heartbeat (Ruling 4): written by the scheduler at the start and end
-- of each business pass, read by the deletion to refuse while one is in flight.
ALTER TABLE businesses DROP CONSTRAINT businesses_status_check;
ALTER TABLE businesses ADD CONSTRAINT businesses_status_check
    CHECK (status IN ('active', 'suspended', 'deleting'));
ALTER TABLE businesses ADD COLUMN pass_started_at timestamptz;
ALTER TABLE businesses ADD COLUMN pass_finished_at timestamptz;

-- ---------------------------------------------------------------------------
-- audit_log stays append-only — with one actor allowed to DELETE (Ruling 2).
--
-- A DELETE passes only when BOTH hold:
--   * `current_user` is the owner of audit_log. Inside the SECURITY DEFINER
--     function below that is the migrator; the app and platform logins own
--     nothing, so they never are.
--   * `app.deleting_business` names the row's own business. The app account
--     can set that setting, which is why it is not enough alone.
-- UPDATE is refused always, by anyone. The refusal text is unchanged.
--
-- This is the only trigger in the schema that refuses a DELETE (checked over
-- every migration up to 080). The other protections a whole-business delete
-- meets are not triggers and need nothing here: `business_descriptions` and
-- `platform_activity_log` withhold DELETE by GRANT only, which the owner is not
-- subject to; and the RESTRICT / NO ACTION foreign keys (`signatures` →
-- `documents`, `spend_ledger` → `audit_log`, `jobs` → `charter_versions`) are
-- ordered by the rounds below, not bypassed.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND current_user::text = (SELECT pg_get_userbyid(c.relowner)::text
                                   FROM pg_class c WHERE c.oid = TG_RELID)
       AND current_setting('app.deleting_business', true) = OLD.business_id THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'audit_log is append-only: % on seq % rejected', TG_OP, OLD.seq;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- delete_business_rows(p_business): every row whose business_id is
-- p_business, from every base table in `public` that has the column — except
-- `businesses`, which the caller deletes last, after the files.
--
-- * The tables are found here, at call time, from information_schema — never a
--   list — so a table a later migration adds is covered by construction
--   (Ruling 1). That includes `platform_activity_log`, which has no RLS: its
--   `business_id` names the business an action touched, and those rows go too
--   (the spec: nothing records that the business existed).
-- * Rounds, not a hand-kept order: each round tries every remaining table in
--   its own subtransaction; a table a foreign key blocked (foreign_key_violation)
--   is rolled back and retried next round. A round in which no table succeeds
--   raises, naming the tables still blocked. The remaining set shrinks every
--   round, so the loop ends.
-- * One transaction (Ruling 3): a raise rolls every round back with it.
-- * FORCE row level security applies to the owner too, so `app.business_id` is
--   set (transaction-local) to the business being deleted; every policy then
--   matches exactly its rows. Both settings are put back before returning.
-- * Returns one row per table the function's own DELETE removed rows from.
--   Rows removed by a cascade are counted under the table that caused them.
-- * SECURITY DEFINER, owned by the migrator (who owns audit_log), with a fixed
--   search_path. EXECUTE only for `assistant_platform_group`; the app account
--   cannot call it. One caller in code: `src/tenancy/business-deletion.ts`.
CREATE FUNCTION delete_business_rows(p_business text)
RETURNS TABLE (table_name text, deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
    v_prev_business  text := coalesce(current_setting('app.business_id', true), '');
    v_prev_deleting  text := coalesce(current_setting('app.deleting_business', true), '');
    v_remaining      text[];
    v_blocked        text[];
    v_table          text;
    v_count          bigint;
BEGIN
    IF p_business IS NULL OR p_business = '' THEN
        RAISE EXCEPTION 'delete_business_rows: no business';
    END IF;

    PERFORM set_config('app.business_id', p_business, true);
    PERFORM set_config('app.deleting_business', p_business, true);

    SELECT coalesce(array_agg(t.tname ORDER BY t.tname), '{}')
      INTO v_remaining
      FROM (SELECT DISTINCT c.table_name::text AS tname
              FROM information_schema.columns c
              JOIN information_schema.tables tb
                ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
             WHERE c.table_schema = 'public'
               AND c.column_name = 'business_id'
               AND tb.table_type = 'BASE TABLE'
               AND c.table_name <> 'businesses') t;

    LOOP
        EXIT WHEN cardinality(v_remaining) = 0;
        v_blocked := '{}';
        FOREACH v_table IN ARRAY v_remaining LOOP
            BEGIN
                EXECUTE format('DELETE FROM public.%I WHERE business_id = $1', v_table)
                  USING p_business;
                GET DIAGNOSTICS v_count = ROW_COUNT;
                IF v_count > 0 THEN
                    table_name := v_table;
                    deleted := v_count;
                    RETURN NEXT;
                END IF;
            EXCEPTION WHEN foreign_key_violation THEN
                v_blocked := v_blocked || v_table;
            END;
        END LOOP;
        IF cardinality(v_blocked) = cardinality(v_remaining) THEN
            RAISE EXCEPTION 'business deletion incomplete: %', array_to_string(v_blocked, ', ');
        END IF;
        v_remaining := v_blocked;
    END LOOP;

    PERFORM set_config('app.deleting_business', v_prev_deleting, true);
    PERFORM set_config('app.business_id', v_prev_business, true);
    RETURN;
END
$$;

REVOKE EXECUTE ON FUNCTION delete_business_rows(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_business_rows(text) TO assistant_platform_group;
