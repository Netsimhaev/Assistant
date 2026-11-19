/**
 * Learning from external-system events (Stage D, Task 12): a learning job is
 * `unknown_external`, curates chunk-only under its own daily cap, never
 * retires a fact, and never carries a plan — so no `ext.*` step.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
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
});
