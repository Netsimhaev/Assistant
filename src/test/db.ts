import { getPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';

let migrated = false;

/** Apply migrations once per test process. */
export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  await migrate();
  migrated = true;
}

/**
 * Wipe every table between tests.
 *
 * `audit_log` carries an append-only trigger that rejects DELETE, so TRUNCATE
 * is not merely faster here — it is the only way to reset it. That is a
 * deliberate property of the schema, not an inconvenience to work around.
 */
export async function resetDatabase(): Promise<void> {
  await ensureSchema();
  await getPool().query(`
    TRUNCATE TABLE
      audit_log,
      agent_envelopes,
      verification_verdicts,
      job_step_results,
      job_plans,
      connection_bindings,
      approval_requests,
      spend_ledger,
      autonomy_ramp,
      autonomy_mode,
      autonomy_marks,
      autonomy_events,
      kill_switch,
      job_steps,
      job_authorizations,
      jobs,
      -- Not reached by CASCADE: memories.written_by_job is deliberately not a
      -- foreign key, because a memory outlives the job that wrote it. That is
      -- the right call for production, and it means this list has to name the
      -- table by hand or one test's memories leak into the next.
      memories,
      kept_items,
      oauth_grants,
      oauth_states,
      credentials,
      credential_key_state,
      proposals,
      document_readings,
      document_artifacts,
      signatures,
      documents,
      charter_active,
      charter_versions,
      dashboard_sessions,
      dashboard_recovery_codes,
      dashboard_unknown_user_throttle,
      dashboard_users
    RESTART IDENTITY CASCADE
  `);
}
