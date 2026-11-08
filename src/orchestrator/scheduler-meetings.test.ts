/**
 * `schedulerPass` meetings wiring: the sweep runs every pass, after the
 * closes, and reports what it did; a throw inside it is isolated.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installMailboxCharter } from '../test/mailbox.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createJob } from './jobs.js';
import type { Runtime } from './runtime.js';
import { schedulerPass } from './scheduler.js';

const B = 'test-business';
const NOW = new Date('2026-11-08T08:00:00.000Z');

function runtime(): Runtime {
  return {
    registry: new AdapterRegistry([]),
    credentials: { resolve: async () => null },
    warnings: [],
  } as unknown as Runtime;
}

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('schedulerPass meetings sweep', () => {
  it('scheduler pass runs the sweep and reports it', async () => {
    const charterVersion = (await installMailboxCharter(B)).charterVersion;
    const job = await createJob({ charterVersion, provenance: 'boss', title: 'פגישה', businessId: B });
    await getPool().query(`UPDATE jobs SET phase = 'closed' WHERE job_id = $1`, [job.jobId]);
    await getPool().query(
      `INSERT INTO job_plans (business_id, job_id, plan_hash, plan) VALUES ($1, $2, 'h', '{}'::jsonb)`,
      [B, job.jobId],
    );
    await getPool().query(
      `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, external_id, status, performed)
       VALUES ($1, $2, 'h', 's1', 'ev-1', 'completed', true)`,
      [B, job.jobId],
    );
    await getPool().query(
      `INSERT INTO meetings (meeting_id, business_id, job_id, step_id, calendar_id, event_id, operation, client_name,
          client_email, start_at, end_at)
       VALUES ('M-1', $1, $2, 's1', 'cal-1', NULL, 'create', 'דני', 'dani@acme.co.il', $3, $4)`,
      [B, job.jobId, new Date('2026-11-10T08:00:00Z'), new Date('2026-11-10T09:00:00Z')],
    );

    const pass = await schedulerPass({ businessId: B, runtime: runtime(), now: NOW, inbox: null });

    expect(pass.meetingsError).toBeNull();
    expect(pass.meetings).toMatchObject({ activated: 1, abandoned: 0, remindersOpened: 0 });
    const { rows } = await getPool().query<{ state: string; event_id: string }>(
      `SELECT state, event_id FROM meetings WHERE meeting_id = 'M-1'`,
    );
    expect(rows[0]).toEqual({ state: 'active', event_id: 'ev-1' });
  });

  it('a sweep with nothing to do reports zeros, not null', async () => {
    await installMailboxCharter(B);
    const pass = await schedulerPass({ businessId: B, runtime: runtime(), now: NOW, inbox: null });
    expect(pass.meetingsError).toBeNull();
    expect(pass.meetings).toMatchObject({ activated: 0, abandoned: 0, responsesChanged: 0, holdsReleased: 0 });
  });
});
