import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob } from '../orchestrator/jobs.js';
import { bindPlanToJob } from '../orchestrator/plan-store.js';
import { recallMemories, writeMemory } from './store.js';
import { curateJob } from './curate.js';
import type { CurationResult } from './curation-parse.js';

const BUSINESS = 'test-business';
const RONIT = 'ronit@beta-log.example';

async function seedJob(provenance: 'boss' | 'unknown_external', toolName = 'mail.send'): Promise<string> {
  // A fresh version per call: `charter_versions`' primary key is
  // (business_id, charter_version), and several tests here call `seedJob`
  // more than once against the same BUSINESS.
  const bundle = await installCharter(buildCharter({ version: `curation-${randomUUID()}` }), {
    businessId: BUSINESS,
  });
  // `createJob` takes ONE argument and requires `charterVersion`. There is no
  // `counterpartyTags` on it — preflight for Task 2 caught this shape.
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance,
    title: 'עדכון לרונית',
    businessId: BUSINESS,
  });
  await bindPlanToJob(
    job.jobId,
    {
      goal: 'עדכון',
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'לשלוח',
          toolName,
          input: { to: RONIT, subject: 'עדכון', body: 'נדבר בטלפון' },
          dependsOn: [],
          expectedActionClass: null,
        },
      ],
    } as never,
    { businessId: BUSINESS },
  );
  return job.jobId;
}

function curatorReturning(candidates: CurationResult['candidates']) {
  return async (): Promise<CurationResult> => ({ candidates });
}

describe('the curator', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('writes what the model returned, with provenance from the job', async () => {
    const jobId = await seedJob('unknown_external');

    const outcome = await curateJob(jobId, {
      businessId: BUSINESS,
      curator: curatorReturning([
        {
          kind: 'preference',
          subjectKey: RONIT,
          attribute: 'ערוץ מועדף',
          body: { value: 'טלפון' },
          sourceRef: 'גוף ההודעה',
        },
      ]),
    });

    expect(outcome.written).toBe(1);
    const [memory] = await recallMemories({ subjectKey: RONIT }, { businessId: BUSINESS });
    // The model never said this; it was read from the job row.
    expect(memory?.provenance).toBe('unknown_external');
  });

  it('does not run on a job that neither read nor communicated', async () => {
    // `crm.write` IS outbound (curation-trigger.test.ts documents exactly
    // this mistake) — `mail.draft` is genuinely outside both tables.
    const jobId = await seedJob('boss', 'mail.draft');

    const outcome = await curateJob(jobId, {
      businessId: BUSINESS,
      curator: async () => {
        throw new Error('the model must not be called for this job');
      },
    });

    expect(outcome).toMatchObject({ ran: false, skipped: 'not_qualified', written: 0 });
  });

  it('refuses a candidate about somebody the job never touched, and writes the rest', async () => {
    const jobId = await seedJob('boss');

    const outcome = await curateJob(jobId, {
      businessId: BUSINESS,
      curator: curatorReturning([
        { kind: 'chunk', subjectKey: RONIT, body: { text: 'טוב' }, sourceRef: 'x' },
        { kind: 'chunk', subjectKey: 'dana@rival.example', body: { text: 'רע' }, sourceRef: 'x' },
      ]),
    });

    expect(outcome).toMatchObject({ written: 1, rejected: 1 });
    const stranger = await recallMemories(
      { subjectKey: 'dana@rival.example' },
      { businessId: BUSINESS },
    );
    expect(stranger).toEqual([]);
  });

  /**
   * Decision 3, the half that matters. The owner said it; a supplier's
   * document disagrees. The owner's row must still be the live one.
   */
  it('keeps the owner’s preference live and records the external claim as a chunk', async () => {
    const bossJob = await seedJob('boss');
    await writeMemory(
      {
        jobId: bossJob,
        kind: 'preference',
        subjectKey: RONIT,
        attribute: 'ערוץ מועדף',
        body: { value: 'מייל' },
      },
      { businessId: BUSINESS },
    );

    const strangerJob = await seedJob('unknown_external');
    await curateJob(strangerJob, {
      businessId: BUSINESS,
      curator: curatorReturning([
        {
          kind: 'preference',
          subjectKey: RONIT,
          attribute: 'ערוץ מועדף',
          body: { value: 'טלפון' },
          sourceRef: 'מסמך של הספק',
        },
      ]),
    });

    const live = await recallMemories({ subjectKey: RONIT }, { businessId: BUSINESS });
    const preference = live.find((m) => m.kind === 'preference');
    const chunk = live.find((m) => m.kind === 'chunk');

    expect(preference?.body).toEqual({ value: 'מייל' });
    expect(preference?.provenance).toBe('boss');
    expect(chunk?.provenance).toBe('unknown_external');
    expect(JSON.stringify(chunk?.body)).toContain('טלפון');
  });

  it('replaces the old row when both came from the same trust level', async () => {
    const first = await seedJob('boss');
    await writeMemory(
      {
        jobId: first,
        kind: 'preference',
        subjectKey: RONIT,
        attribute: 'ערוץ מועדף',
        body: { value: 'מייל' },
      },
      { businessId: BUSINESS },
    );

    const second = await seedJob('boss');
    await curateJob(second, {
      businessId: BUSINESS,
      curator: curatorReturning([
        {
          kind: 'preference',
          subjectKey: RONIT,
          attribute: 'ערוץ מועדף',
          body: { value: 'טלפון' },
          sourceRef: 'x',
        },
      ]),
    });

    const live = await recallMemories({ subjectKey: RONIT }, { businessId: BUSINESS });
    expect(live.filter((m) => m.kind === 'preference')).toHaveLength(1);
    expect(live.find((m) => m.kind === 'preference')?.body).toEqual({ value: 'טלפון' });
  });

  it('records a curation audit row carrying counts and no subject', async () => {
    const jobId = await seedJob('boss');

    await curateJob(jobId, {
      businessId: BUSINESS,
      curator: curatorReturning([
        { kind: 'chunk', subjectKey: RONIT, body: { text: 'סיכום' }, sourceRef: 'x' },
      ]),
    });

    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE business_id = $1 AND kind = 'curation'`,
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toContain('1');
    expect(rows[0]?.reason).not.toContain(RONIT);
  });

  it('closes the job’s curation without throwing when the model fails', async () => {
    const jobId = await seedJob('boss');

    const outcome = await curateJob(jobId, {
      businessId: BUSINESS,
      curator: async () => {
        throw new Error('model unavailable');
      },
    });

    expect(outcome).toMatchObject({ ran: false, written: 0 });
  });
});
