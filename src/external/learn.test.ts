/**
 * Learning from external-system events (Stage D, Task 12): a learning job is
 * `unknown_external`, curates chunk-only under its own daily cap, never
 * retires a fact, and never carries a plan — so no `ext.*` step.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, withBusiness, type BusinessDb } from '../db/pool.js';
import { createJob } from '../orchestrator/jobs.js';
import type { CurationBrief } from '../memory/curation-brief.js';
import type { CurationResult } from '../memory/curation-parse.js';
import { curationRunsToday } from '../memory/curate.js';
import { writeMemory } from '../memory/store.js';
import { crmConnection, crmFixture } from '../test/external-fixtures.js';
import { buildCharter } from '../test/fixtures.js';
import { registerBusiness, resetDatabase, testDb } from '../test/db.js';
import { LEARNING_JOB_TITLE, learnFromExternalEvents } from './learn.js';
import { insertEvent } from './store.js';

const BUSINESS = 'learn-shop';
const SUBJECT = 'ext:crm';

async function install(): Promise<string> {
  await registerBusiness(BUSINESS);
  return withBusiness(BUSINESS, async (db) => {
    await installCharter(db, buildCharter({ externalSystems: [crmFixture()], connections: [crmConnection()] }));
    const { rows } = await db.query<{ charter_version: string }>(
      'SELECT charter_version FROM charter_active WHERE business_id = $1',
      [BUSINESS],
    );
    return rows[0]?.charter_version ?? '';
  });
}

async function seedEvents(n: number, extra: { value?: string } = {}): Promise<void> {
  await withBusiness(BUSINESS, async (db) => {
    for (let i = 0; i < n; i += 1) {
      await insertEvent(db, {
        systemId: 'crm',
        source: i % 2 === 0 ? 'webhook' : 'scan',
        eventType: 'customer.created',
        itemHash: `h-${i}`,
        fields: [{ label: 'שם', value: extra.value ?? `לקוח ${i}` }],
      });
    }
  });
}

function learn(curator: (brief: CurationBrief) => Promise<CurationResult>, runsPerDay?: number) {
  return withBusiness(BUSINESS, (db) =>
    learnFromExternalEvents(db, { curator, ...(runsPerDay !== undefined ? { runsPerDay } : {}) }),
  );
}

async function uncurated(): Promise<number> {
  const { rows } = await testDb().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM external_events WHERE business_id = $1 AND curated_at IS NULL`,
    [BUSINESS],
  );
  return Number(rows[0]?.n ?? '0');
}

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('learnFromExternalEvents', () => {
  it('a learning job is unknown_external, writes only chunks, and retires nothing', async () => {
    const charterVersion = await install();
    // A fact the OWNER holds about the same subject — it must survive.
    const bossJob = await withBusiness(BUSINESS, (db) => createJob(db, { charterVersion, provenance: 'boss', title: 'x' }));
    await withBusiness(BUSINESS, (db) =>
      writeMemory(db, { jobId: bossJob.jobId, kind: 'entity', subjectKey: SUBJECT, body: { name: 'המערכת שלנו' } }),
    );
    await seedEvents(3, { value: 'דנה \u202Eכהן' });

    let brief: CurationBrief | null = null;
    const out = await learn(async (b) => {
      brief = b;
      return {
        candidates: [
          { kind: 'entity', subjectKey: SUBJECT, body: { name: 'מתחזה' }, sourceRef: 'אירוע 1' },
          { kind: 'preference', subjectKey: SUBJECT, attribute: 'מטבע', body: { value: 'USD' }, sourceRef: 'אירוע 2' },
          { kind: 'chunk', subjectKey: 'someone@else.example', body: { claim: 'x' }, sourceRef: 'אירוע 3' },
        ],
      };
    });
    expect(out).toMatchObject({ jobs: 1, curated: 3, warnings: [] });

    // The brief: the system's signed label, the declared fields, fenced, bidi stripped.
    const text = (brief as CurationBrief | null)?.text ?? '';
    expect(text).toContain('מערכת הלקוחות');
    expect(text).toContain('שם: דנה כהן');
    expect(text).not.toContain('\u202E');
    expect(text).toMatch(/=== נתונים ממערכת חיצונית: מערכת הלקוחות :: [0-9a-f]{24} ===/);
    expect((brief as CurationBrief | null)?.touched).toEqual({ recipients: [], entityIds: [SUBJECT] });

    const { rows: jobs } = await testDb().query<{ job_id: string; provenance: string; phase: string }>(
      `SELECT job_id, provenance, phase FROM jobs WHERE business_id = $1 AND title = $2`,
      [BUSINESS, LEARNING_JOB_TITLE],
    );
    expect(jobs).toEqual([expect.objectContaining({ provenance: 'unknown_external', phase: 'closed' })]);
    const learningJob = jobs[0]?.job_id ?? '';

    // Never a plan, so never an `ext.*` step (or any step).
    const plans = await testDb().query('SELECT 1 FROM job_plans WHERE business_id = $1 AND job_id = $2', [BUSINESS, learningJob]);
    expect(plans.rowCount).toBe(0);

    const { rows: memories } = await testDb().query<{ kind: string; provenance: string; retired_at: Date | null; written_by_job: string }>(
      `SELECT kind, provenance, retired_at, written_by_job FROM memories WHERE business_id = $1 ORDER BY created_at`,
      [BUSINESS],
    );
    const learned = memories.filter((m) => m.written_by_job === learningJob);
    expect(learned).toHaveLength(2);
    expect(learned.every((m) => m.kind === 'chunk' && m.provenance === 'unknown_external')).toBe(true);
    // The owner's entity is still live.
    const owners = memories.filter((m) => m.written_by_job === bossJob.jobId);
    expect(owners).toEqual([expect.objectContaining({ kind: 'entity', retired_at: null })]);

    expect(await uncurated()).toBe(0);
    expect(await withBusiness(BUSINESS, (db) => curationRunsToday(db, { scope: 'external' }))).toBe(1);
    expect(await withBusiness(BUSINESS, (db) => curationRunsToday(db))).toBe(0);
  });

  it('takes at most 20 events per system per pass; the rest wait for the next', async () => {
    await install();
    await seedEvents(25);
    const sizes: number[] = [];
    const curator = async (b: CurationBrief): Promise<CurationResult> => {
      sizes.push((b.text.match(/^\d+\. \[/gm) ?? []).length);
      return { candidates: [] };
    };
    expect(await learn(curator)).toMatchObject({ jobs: 1, curated: 20 });
    expect(await uncurated()).toBe(5);
    expect(await learn(curator)).toMatchObject({ jobs: 1, curated: 5 });
    expect(sizes).toEqual([20, 5]);
    expect(await learn(curator)).toMatchObject({ jobs: 0, curated: 0 });
  });

  it('the daily cap leaves events for tomorrow, and 0 turns learning off', async () => {
    await install();
    await seedEvents(2);
    let calls = 0;
    const curator = async (): Promise<CurationResult> => {
      calls += 1;
      return { candidates: [] };
    };
    expect(await learn(curator, 0)).toMatchObject({ jobs: 0, curated: 0 });
    expect(calls).toBe(0);
    expect(await uncurated()).toBe(2);

    await learn(curator, 1);
    expect(calls).toBe(1);
    await withBusiness(BUSINESS, (db) =>
      insertEvent(db, { systemId: 'crm', source: 'scan', eventType: 'x', itemHash: 'later', fields: [{ label: 'a', value: 'b' }] }),
    );
    const capped = await learn(curator, 1);
    expect(capped).toMatchObject({ jobs: 0, curated: 0 });
    expect(calls).toBe(1);
    expect(await uncurated()).toBe(1);
  });

  it('events of a system the active charter does not carry are not learned from', async () => {
    await registerBusiness(BUSINESS);
    await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter({})));
    await seedEvents(2);
    let calls = 0;
    const out = await learn(async () => {
      calls += 1;
      return { candidates: [] };
    });
    expect(out).toMatchObject({ jobs: 0, curated: 0 });
    expect(calls).toBe(0);
  });

  it('a curator that throws still marks the batch (the call was attempted) and fails the job', async () => {
    await install();
    await seedEvents(2);
    const out = await learn(async () => {
      throw new Error('model down');
    });
    expect(out).toMatchObject({ jobs: 1, curated: 2 });
    const { rows } = await testDb().query<{ phase: string }>(
      `SELECT phase FROM jobs WHERE business_id = $1 AND title = $2`,
      [BUSINESS, LEARNING_JOB_TITLE],
    );
    expect(rows.map((r) => r.phase)).toEqual(['failed']);
  });

  it('a claim left by a crashed pass is released and the orphan job failed', async () => {
    const charterVersion = await install();
    await seedEvents(1);
    const orphan = await withBusiness(BUSINESS, (db) =>
      createJob(db, { charterVersion, provenance: 'unknown_external', title: LEARNING_JOB_TITLE }),
    );
    await testDb().query(`UPDATE jobs SET phase = 'understand', created_at = now() - interval '2 hours' WHERE job_id = $1`, [orphan.jobId]);
    await testDb().query(`UPDATE external_events SET curation_job_id = $1 WHERE business_id = $2`, [orphan.jobId, BUSINESS]);

    const out = await learn(async () => ({ candidates: [] }));
    expect(out).toMatchObject({ jobs: 1, curated: 1 });
    const { rows } = await testDb().query<{ phase: string }>('SELECT phase FROM jobs WHERE job_id = $1', [orphan.jobId]);
    expect(rows[0]?.phase).toBe('failed');
  });

  it('an open learning job holding no claim is failed once stale — at the start of the pass, even at cap 0', async () => {
    const charterVersion = await install();
    const open = async (phase: 'intake' | 'understand', minutesAgo: number): Promise<string> => {
      const job = await withBusiness(BUSINESS, (db) =>
        createJob(db, { charterVersion, provenance: 'unknown_external', title: LEARNING_JOB_TITLE }),
      );
      await testDb().query(
        'INSERT INTO external_learning_jobs (business_id, job_id, system_id) VALUES ($1, $2, $3)',
        [BUSINESS, job.jobId, 'crm'],
      );
      await testDb().query(
        `UPDATE jobs SET phase = $2, created_at = now() - make_interval(mins => $3) WHERE job_id = $1`,
        [job.jobId, phase, minutesAgo],
      );
      return job.jobId;
    };
    const staleIntake = await open('intake', 31);
    const staleUnderstand = await open('understand', 45);
    const young = await open('understand', 5);

    const out = await learn(async () => ({ candidates: [] }), 0);
    expect(out).toMatchObject({ jobs: 0, curated: 0 });

    const phases = await testDb().query<{ job_id: string; phase: string }>(
      'SELECT job_id, phase FROM jobs WHERE job_id = ANY ($1)',
      [[staleIntake, staleUnderstand, young]],
    );
    const phaseOf = new Map(phases.rows.map((r) => [r.job_id, r.phase]));
    expect(phaseOf.get(staleIntake)).toBe('failed');
    expect(phaseOf.get(staleUnderstand)).toBe('failed');
    expect(phaseOf.get(young)).toBe('understand');
    const failed = await testDb().query<{ job_id: string }>(
      'SELECT job_id FROM external_learning_jobs WHERE failed_at IS NOT NULL ORDER BY job_id',
    );
    expect(failed.rows.map((r) => r.job_id).sort()).toEqual([staleIntake, staleUnderstand].sort());
  });

  it('the stale sweep runs even when no charter carries a system', async () => {
    await registerBusiness(BUSINESS);
    const charterVersion = await withBusiness(BUSINESS, async (db) => {
      await installCharter(db, buildCharter({ version: 'no-systems' }));
      const { rows } = await db.query<{ charter_version: string }>(
        'SELECT charter_version FROM charter_active WHERE business_id = $1',
        [BUSINESS],
      );
      return rows[0]?.charter_version ?? '';
    });
    const job = await withBusiness(BUSINESS, (db) =>
      createJob(db, { charterVersion, provenance: 'unknown_external', title: LEARNING_JOB_TITLE }),
    );
    await testDb().query('INSERT INTO external_learning_jobs (business_id, job_id, system_id) VALUES ($1, $2, $3)', [
      BUSINESS,
      job.jobId,
      'crm',
    ]);
    await testDb().query(`UPDATE jobs SET created_at = now() - interval '2 hours' WHERE job_id = $1`, [job.jobId]);

    await learn(async () => ({ candidates: [] }));
    const { rows } = await testDb().query<{ phase: string }>('SELECT phase FROM jobs WHERE job_id = $1', [job.jobId]);
    expect(rows[0]?.phase).toBe('failed');
  });

  it('a throw before the model call leaves the events uncurated and unclaimed, and marks the job failed', async () => {
    await install();
    await seedEvents(2);
    let calls = 0;
    const curator = async (): Promise<CurationResult> => {
      calls += 1;
      return { candidates: [] };
    };
    // Break `buildExternalBrief`: its label lookup reads charter_active.
    const out = await withBusiness(BUSINESS, (real) => {
      const db: BusinessDb = {
        businessId: real.businessId,
        inTransaction: real.inTransaction,
        query: ((text: string, values?: unknown[]) => {
          if (text.includes("cv.charter -> 'externalSystems'")) throw new Error('brief fault');
          return real.query(text, values as never);
        }) as BusinessDb['query'],
      };
      return learnFromExternalEvents(db, { curator });
    });
    expect(calls).toBe(0);
    expect(out).toMatchObject({ jobs: 1, curated: 0 });
    expect(await uncurated()).toBe(2);
    const claimed = await testDb().query(
      `SELECT 1 FROM external_events WHERE business_id = $1 AND curation_job_id IS NOT NULL`,
      [BUSINESS],
    );
    expect(claimed.rowCount).toBe(0);
    const { rows } = await testDb().query<{ failed_at: Date | null; phase: string }>(
      `SELECT l.failed_at, j.phase FROM external_learning_jobs l JOIN jobs j ON j.job_id = l.job_id WHERE l.business_id = $1`,
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.failed_at).not.toBeNull();
    expect(rows[0]?.phase).toBe('failed');

    // The next pass retries them.
    expect(await learn(curator)).toMatchObject({ jobs: 1, curated: 2 });
    expect(calls).toBe(1);
  });

  it('a throw after the job was opened leaves it failed, not stuck in understand', async () => {
    await install();
    await seedEvents(2);
    const out = await withBusiness(BUSINESS, (real) => {
      const db: BusinessDb = {
        businessId: real.businessId,
        inTransaction: real.inTransaction,
        query: ((text: string, values?: unknown[]) => {
          if (text.includes('SET curation_job_id = $3')) throw new Error('claim fault');
          return real.query(text, values as never);
        }) as BusinessDb['query'],
      };
      return learnFromExternalEvents(db, { curator: async () => ({ candidates: [] }) });
    });
    expect(out.jobs).toBe(1);
    expect(out.warnings.join(' ')).toContain('failed');
    const { rows } = await testDb().query<{ phase: string; failed_at: Date | null }>(
      `SELECT j.phase, l.failed_at FROM external_learning_jobs l JOIN jobs j ON j.job_id = l.job_id WHERE l.business_id = $1`,
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phase).toBe('failed');
    expect(rows[0]?.failed_at).not.toBeNull();
    expect(await uncurated()).toBe(2);
  });

  it('a stale orphan another pass already moved is not recorded as a learning failure', async () => {
    const charterVersion = await install();
    await seedEvents(1);
    const orphan = await withBusiness(BUSINESS, (db) =>
      createJob(db, { charterVersion, provenance: 'unknown_external', title: LEARNING_JOB_TITLE }),
    );
    await testDb().query(
      `INSERT INTO external_learning_jobs (business_id, job_id, system_id) VALUES ($1, $2, 'crm')`,
      [BUSINESS, orphan.jobId],
    );
    await testDb().query(`UPDATE jobs SET phase = 'understand', created_at = now() - interval '2 hours' WHERE job_id = $1`, [orphan.jobId]);
    await testDb().query(`UPDATE external_events SET curation_job_id = $1 WHERE business_id = $2`, [orphan.jobId, BUSINESS]);

    let raced = false;
    await withBusiness(BUSINESS, (real) => {
      const db: BusinessDb = {
        businessId: real.businessId,
        inTransaction: real.inTransaction,
        query: (async (text: string, values?: unknown[]) => {
          if (!raced && text.includes('FOR UPDATE') && Array.isArray(values) && values[0] === orphan.jobId) {
            raced = true;
            // Another pass moves the job between the sweep's read and its transition.
            await testDb().query(`UPDATE jobs SET phase = 'closed' WHERE job_id = $1`, [orphan.jobId]);
          }
          return real.query(text, values as never);
        }) as BusinessDb['query'],
      };
      return learnFromExternalEvents(db, { curator: async () => ({ candidates: [] }) });
    });
    expect(raced).toBe(true);
    const { rows } = await testDb().query<{ failed_at: Date | null }>(
      `SELECT failed_at FROM external_learning_jobs WHERE job_id = $1`,
      [orphan.jobId],
    );
    expect(rows[0]?.failed_at).toBeNull();
  });
});
