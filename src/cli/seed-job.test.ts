import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { CharterConnection } from '../domain/connection.js';
import { loadJob } from '../orchestrator/jobs.js';
import { loadPlanBody } from '../orchestrator/plan-store.js';
import { loadRampLevel } from '../orchestrator/ramp.js';
import { seedMailJob } from './seed-job.js';

const BUSINESS = 'test-business';

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
    await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), {
      businessId: BUSINESS,
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it('leaves the job in execute, bound to a one-step plan', async () => {
    const { jobId } = await seedMailJob({
      to: 'dana@example.com',
      subject: 'נושא',
      body: 'גוף',
      businessId: BUSINESS,
    });

    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('execute');
    const stored = await loadPlanBody(jobId, { businessId: BUSINESS });
    expect(stored?.plan.steps).toHaveLength(1);
    expect(stored?.plan.steps[0]?.toolName).toBe('mail.send');
    expect(stored?.plan.steps[0]?.expectedActionClass).toBe('email.initiate');
  });

  it('raises the ramp for email.initiate only, and only to approve_required', async () => {
    await seedMailJob({
      to: 'dana@example.com',
      subject: 'נושא',
      body: 'גוף',
      businessId: BUSINESS,
    });

    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe('approve_required');
    // Every other class stays on the floor. A seed command that raised the
    // whole business would be a far larger grant than it appears to make.
    expect(await loadRampLevel('purchase.place', { businessId: BUSINESS })).toBe('draft_only');
    expect(await loadRampLevel('crm.write', { businessId: BUSINESS })).toBe('draft_only');
  });

  it('refuses when no charter is installed', async () => {
    await resetDatabase();
    await expect(
      seedMailJob({ to: 'dana@example.com', subject: 's', body: 'b', businessId: BUSINESS }),
    ).rejects.toThrow(/charter/i);
  });
});
