import type pg from 'pg';
import { getMigratorPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { ensureRoles } from '../db/roles.js';
import { config } from '../config.js';

let migrated = false;

/**
 * Create the test logins and apply migrations, once per test process — both
 * on the MIGRATOR pool (the superuser in `TEST_DATABASE_URL`). The app code
 * under test then runs as `assistant_app_test`, which owns nothing.
 */
export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  const admin = await getMigratorPool().connect();
  try {
    if (config.testLogins === null) throw new Error('ensureSchema runs only under NODE_ENV=test');
    await ensureRoles(admin, config.testLogins);
  } finally {
    admin.release();
  }
  await migrate();
  migrated = true;
}

/**
 * The migrator (table-owner) pool, for test seeding and assertions that need
 * ownership: TRUNCATE, DDL, `ALTER TABLE ... DISABLE TRIGGER`, temporary
 * test triggers. The app role must never own tables, so these cannot run on
 * `getPool()`.
 */
export function testDb(): pg.Pool {
  return getMigratorPool();
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
  await testDb().query(`
    TRUNCATE TABLE
      audit_log,
      meeting_holds,
      meetings,
      meeting_settings,
      document_settings,
      document_deliveries,
      document_cards,
      document_versions,
      document_productions,
      whatsapp_messages,
      mail_invoices,
      mail_messages,
      mailbox_cursor,
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
      ledger_whatsapp_batches,
      ledger_critical_rules,
      ledger_settings,
      ledger_reminders,
      ledger_events,
      ledger_items,
      action_updates,
      action_update_settings,
      instruction_confirmations,
      confirmed_step_claims,
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
      digest_settings,
      digests,
      charter_interview_drafts,
      dashboard_sessions,
      dashboard_recovery_codes,
      dashboard_unknown_user_throttle,
      dashboard_users
    RESTART IDENTITY CASCADE
  `);
}
