import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { writeMemory } from '../memory/store.js';
import { keepItem } from './kept-items.js';
import { buildErasurePlan } from './erasure-plan.js';

const BUSINESS = 'test-business';
const RONIT = 'ronit@beta-log.example';

/** A job that mentions the anchor in its authorisation and its plan. */
async function jobAbout(identifier: string, title: string): Promise<string> {
  const bundle = await installCharter(buildCharter({ version: `er-${title}` }), {
    businessId: BUSINESS,
  });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title,
  });
  await getPool().query(
    `INSERT INTO job_authorizations (business_id, job_id, action_class, recipients)
     VALUES ($1, $2, 'email.reply', ARRAY[$3])`,
    [BUSINESS, job.jobId, identifier],
  );
  await getPool().query(
    `INSERT INTO job_plans (business_id, job_id, plan_hash, plan)
     VALUES ($1, $2, 'h1', $3::jsonb)`,
    [BUSINESS, job.jobId, JSON.stringify({ goal: 'send', steps: [{ input: { to: [identifier] } }] })],
  );
  return job.jobId;
}

describe('buildErasurePlan', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('finds a contact through every place the anchor can appear', async () => {
    const jobId = await jobAbout(RONIT, 'about ronit');
    await writeMemory(
      { jobId, kind: 'entity', subjectKey: RONIT, body: { name: 'רונית' } },
      { businessId: BUSINESS },
    );

    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: RONIT },
      { businessId: BUSINESS },
    );

    expect(plan.jobIds).toContain(jobId);
    expect(plan.memoryIds).toHaveLength(1);
    const tables = new Map(plan.items.map((i) => [i.table, i]));
    expect(tables.get('memories')?.action).toBe('delete');
    expect(tables.get('job_plans')?.action).toBe('delete');
    expect(tables.get('job_authorizations')?.action).toBe('delete');
    // A job row survives with its content emptied — audit rows point at it.
    expect(tables.get('jobs')?.action).toBe('scrub');
  });

  /**
   * The other direction, and the one that makes the test above mean
   * something: an erasure that swept everything would satisfy it perfectly.
   */
  it('leaves a second contact completely untouched', async () => {
    const mine = await jobAbout(RONIT, 'ronit');
    const theirs = await jobAbout('avi@gamma-lift.example', 'avi');
    await writeMemory({ jobId: mine, kind: 'entity', subjectKey: RONIT, body: {} }, { businessId: BUSINESS });
    await writeMemory(
      { jobId: theirs, kind: 'entity', subjectKey: 'avi@gamma-lift.example', body: {} },
      { businessId: BUSINESS },
    );

    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: RONIT },
      { businessId: BUSINESS },
    );

    expect(plan.jobIds).toContain(mine);
    expect(plan.jobIds).not.toContain(theirs);
    expect(plan.memoryIds).toHaveLength(1);
  });

  it('treats a wildcard character in the anchor as a literal', async () => {
    const jobId = await jobAbout(RONIT, 'ronit');
    await writeMemory({ jobId, kind: 'chunk', subjectKey: 'c_1', body: { t: 'x' } }, { businessId: BUSINESS });

    // `%` would match every row if it reached LIKE unescaped.
    const plan = await buildErasurePlan({ kind: 'contact', identifier: '%' }, { businessId: BUSINESS });
    expect(plan.jobIds).toEqual([]);
    expect(plan.memoryIds).toEqual([]);
  });

  it('excludes a kept item and says why, rather than skipping it silently', async () => {
    const jobId = await jobAbout(RONIT, 'ronit');
    const memory = await writeMemory(
      { jobId, kind: 'entity', subjectKey: RONIT, body: {} },
      { businessId: BUSINESS },
    );
    await keepItem({ kind: 'memory', itemId: memory.memoryId, note: 'חשוב' }, { businessId: BUSINESS });

    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: RONIT },
      { businessId: BUSINESS },
    );

    expect(plan.memoryIds).not.toContain(memory.memoryId);
    expect(plan.excluded).toHaveLength(1);
    expect(plan.excluded[0]?.itemId).toBe(memory.memoryId);
    expect(plan.excluded[0]?.note).toBe('חשוב');
  });

  it('refuses while a job it would touch is still waiting on the owner', async () => {
    const jobId = await jobAbout(RONIT, 'ronit');
    for (const to of ['understand', 'plan', 'execute', 'await_approval'] as const) {
      await transition(jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
    }

    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: RONIT },
      { businessId: BUSINESS },
    );

    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]?.kind).toBe('live_job');
    expect(plan.refusals[0]?.detail).toContain(jobId);
  });

  it('builds nothing at all for an anchor nothing matches', async () => {
    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: 'nobody@nowhere.example' },
      { businessId: BUSINESS },
    );
    expect(plan.jobIds).toEqual([]);
    expect(plan.items.every((i) => i.count === 0)).toBe(true);
  });
});
