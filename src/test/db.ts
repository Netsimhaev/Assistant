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
      job_step_results,
      job_plans,
      connection_bindings,
      approval_requests,
      spend_ledger,
      autonomy_ramp,
      kill_switch,
      job_steps,
      jobs,
      charter_active,
      charter_versions
    RESTART IDENTITY CASCADE
  `);
}
