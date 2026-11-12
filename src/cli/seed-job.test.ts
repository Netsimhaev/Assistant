import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { CharterConnection } from '../domain/connection.js';
import { loadJob } from '../orchestrator/jobs.js';
import { loadPlanBody } from '../orchestrator/plan-store.js';
import { seedMailJob } from './seed-job.js';

const BUSINESS = 'test-business';

/**
 * The raw `autonomy_ramp` row, bypassing `loadRampLevel`.
 *
 * `loadRampLevel` now clamps its answer to the owner's dial (Task 2), which
 * defaults to `off` and would flatten every value below to `draft_only` —
 * hiding exactly the thing this file tests: that `seedMailJob` writes ONE row
 * for ONE class, not a business-wide grant. The dial's clamp is
 * `ramp-floor.test.ts`'s job; this reads what was actually written.
 */
async function storedLevel(actionClass: string, businessId: string): Promise<string | undefined> {
  const { rows } = await testDb().query<{ level: string }>(
    'SELECT level FROM autonomy_ramp WHERE business_id = $1 AND action_class = $2',
    [businessId, actionClass],
  );
  return rows[0]?.level;
}

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

describe('seedMailJob', () => {
  beforeEach(async () => {
    await resetDatabase();
    // `installCharter` returns the compiled PolicyBundle directly and takes
    // no `actor` option — see src/orchestrator/run-due.test.ts.
    await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ connections: [MAIL_CONNECTION] })));
  });

  afterAll(async () => {
    await closePool();
  });

  it('leaves the job in execute, bound to a one-step plan', async () => {
    const { jobId } = await withBusiness(BUSINESS, (db) => seedMailJob(db, {
      to: 'dana@example.com',
      subject: 'נושא',
      body: 'גוף',
    }));

    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.phase).toBe('execute');
    const stored = await withBusiness(BUSINESS, (db) => loadPlanBody(db, jobId));
    expect(stored?.plan.steps).toHaveLength(1);
    expect(stored?.plan.steps[0]?.toolName).toBe('mail.send');
    expect(stored?.plan.steps[0]?.expectedActionClass).toBe('email.initiate');
  });

  it('raises the ramp for email.initiate only, and only to approve_required', async () => {
    await withBusiness(BUSINESS, (db) => seedMailJob(db, {
      to: 'dana@example.com',
      subject: 'נושא',
      body: 'גוף',
    }));

    expect(await storedLevel('email.initiate', BUSINESS)).toBe('approve_required');
    // Every other class has no row at all. A seed command that raised the
    // whole business would be a far larger grant than it appears to make.
    expect(await storedLevel('purchase.place', BUSINESS)).toBeUndefined();
    expect(await storedLevel('crm.write', BUSINESS)).toBeUndefined();
  });

  it('refuses when no charter is installed', async () => {
    await resetDatabase();
    await expect(
      withBusiness(BUSINESS, (db) => seedMailJob(db, { to: 'dana@example.com', subject: 's', body: 'b' })),
    ).rejects.toThrow(/charter/i);
  });
});
