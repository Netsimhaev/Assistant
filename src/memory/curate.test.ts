import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob } from '../orchestrator/jobs.js';
import { bindPlanToJob } from '../orchestrator/plan-store.js';
import { recallMemories, writeMemory, type MemoryKind } from './store.js';
import { curateJob, curationRunsToday } from './curate.js';
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

interface LiveRow {
  provenance: string;
  body: unknown;
}

/**
 * The live row at an exact `(kind, subjectKey, attribute)` key, read
 * directly with SQL rather than through `recallMemories`.
 *
 * `recallMemories` pages (default limit 5, newest first) and is exactly the
 * lens that hid the fix-round-1 C1 bug: a target row sitting behind enough
 * newer rows on the same subject fell outside the page and read as absent.
 * The conflict-branch tests below assert against this instead, so they
 * cannot be fooled by the same blind spot they exist to catch.
 */
async function liveRows(
  kind: MemoryKind,
  subjectKey: string,
  attribute: string | null = null,
): Promise<LiveRow[]> {
  const { rows } = await getPool().query<{ provenance: string; body: unknown }>(
    `SELECT provenance, body FROM memories
       WHERE business_id = $1 AND kind = $2 AND subject_key = $3
         AND attribute IS NOT DISTINCT FROM $4 AND retired_at IS NULL`,
    [BUSINESS, kind, subjectKey, attribute],
  );
  return rows.map((row) => ({
    provenance: row.provenance,
    body: typeof row.body === 'string' ? JSON.parse(row.body) : row.body,
  }));
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

    const preferenceRows = await liveRows('preference', RONIT, 'ערוץ מועדף');
    expect(preferenceRows).toHaveLength(1);
    expect(preferenceRows[0]?.body).toEqual({ value: 'מייל' });
    expect(preferenceRows[0]?.provenance).toBe('boss');

    const chunkRows = await liveRows('chunk', RONIT);
    expect(chunkRows).toHaveLength(1);
    expect(chunkRows[0]?.provenance).toBe('unknown_external');
    expect(JSON.stringify(chunkRows[0]?.body)).toContain('טלפון');
  });

  /**
   * Fix round 1, C1. A `boss` preference is protected only if the guard can
   * actually SEE it. `recallMemories` returns at most 5 rows, newest first,
   * with no `attribute` filter — so six newer preferences on other
   * attributes of the same subject used to push the target row off the
   * page entirely, and the guard fell through as if the row did not exist.
   * `resolveConflict` now asks the database for the exact key directly.
   */
  it('protects the owner’s preference even behind many newer rows on the same subject', async () => {
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

    // Six newer, unrelated preferences on the same subject — enough to push
    // the row above past `recallMemories`' default limit of 5.
    for (let i = 0; i < 6; i += 1) {
      await writeMemory(
        {
          jobId: bossJob,
          kind: 'preference',
          subjectKey: RONIT,
          attribute: `תכונה-${i}`,
          body: { value: `x${i}` },
        },
        { businessId: BUSINESS },
      );
    }

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

    const preferenceRows = await liveRows('preference', RONIT, 'ערוץ מועדף');
    expect(preferenceRows).toHaveLength(1);
    expect(preferenceRows[0]?.provenance).toBe('boss');
    expect(preferenceRows[0]?.body).toEqual({ value: 'מייל' });
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

    const preferenceRows = await liveRows('preference', RONIT, 'ערוץ מועדף');
    expect(preferenceRows).toHaveLength(1);
    expect(preferenceRows[0]?.body).toEqual({ value: 'טלפון' });
  });

  /**
   * Fix round 1, I5. The third branch §10 names: an existing claim from
   * BELOW `boss` trust is not protected — a later `boss` job simply
   * replaces it, same as two same-trust writes do.
   */
  it('lets a boss claim replace an external one at the same key', async () => {
    const externalJob = await seedJob('unknown_external');
    await writeMemory(
      {
        jobId: externalJob,
        kind: 'preference',
        subjectKey: RONIT,
        attribute: 'ערוץ מועדף',
        body: { value: 'וואטסאפ' },
      },
      { businessId: BUSINESS },
    );

    const bossJob = await seedJob('boss');
    await curateJob(bossJob, {
      businessId: BUSINESS,
      curator: curatorReturning([
        {
          kind: 'preference',
          subjectKey: RONIT,
          attribute: 'ערוץ מועדף',
          body: { value: 'מייל' },
          sourceRef: 'x',
        },
      ]),
    });

    const preferenceRows = await liveRows('preference', RONIT, 'ערוץ מועדף');
    expect(preferenceRows).toHaveLength(1);
    expect(preferenceRows[0]?.provenance).toBe('boss');
    expect(preferenceRows[0]?.body).toEqual({ value: 'מייל' });

    // No chunk: an external claim losing to a later boss claim is an
    // ordinary replace, not a recorded disagreement.
    const chunkRows = await liveRows('chunk', RONIT);
    expect(chunkRows).toHaveLength(0);
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

  /**
   * Fix round 1, I2 + I3. A billed call that throws must still leave a
   * trace — otherwise the daily cap never advances for a call that was
   * paid for — and the outcome must say plainly that the run failed rather
   * than reading like a quiet no-op.
   */
  it('records a curation audit row and reports failed when the model throws', async () => {
    const jobId = await seedJob('boss');

    const outcome = await curateJob(jobId, {
      businessId: BUSINESS,
      curator: async () => {
        throw new Error('model unavailable');
      },
    });

    expect(outcome).toMatchObject({ ran: false, written: 0, failed: true });

    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE business_id = $1 AND kind = 'curation'`,
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).not.toContain(RONIT);
  });

  /**
   * Fix round 1, I6. The cost-control path had no coverage at all.
   */
  it('refuses to run once the daily cap is reached, without calling the model', async () => {
    const jobId = await seedJob('boss');
    let called = false;

    const outcome = await curateJob(jobId, {
      businessId: BUSINESS,
      runsPerDay: 0,
      curator: async () => {
        called = true;
        return { candidates: [] };
      },
    });

    expect(outcome).toMatchObject({ ran: false, skipped: 'over_cap', written: 0, failed: false });
    expect(called).toBe(false);
  });

  it('refuses to run without ANTHROPIC_API_KEY when no curator is injected', async () => {
    const jobId = await seedJob('boss');
    const original = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];

    try {
      const outcome = await curateJob(jobId, { businessId: BUSINESS });
      expect(outcome).toMatchObject({ ran: false, skipped: 'no_key', written: 0, failed: false });
    } finally {
      if (original !== undefined) process.env['ANTHROPIC_API_KEY'] = original;
    }
  });

  it('curationRunsToday counts curation audit rows written today', async () => {
    expect(await curationRunsToday({ businessId: BUSINESS })).toBe(0);

    const jobId = await seedJob('boss');
    await curateJob(jobId, {
      businessId: BUSINESS,
      curator: curatorReturning([
        { kind: 'chunk', subjectKey: RONIT, body: { text: 'x' }, sourceRef: 'x' },
      ]),
    });

    expect(await curationRunsToday({ businessId: BUSINESS })).toBe(1);
  });
});
