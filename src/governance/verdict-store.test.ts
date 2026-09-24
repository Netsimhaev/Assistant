import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { loadVerdict, loadVerificationOutcome, saveNotJudged, saveVerdict } from './verdict-store.js';
import type { Verdict } from './verdict-store.js';

const BUSINESS = 'test-business';

function aVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    criteria: [
      {
        id: 'c1',
        statement: 'הסכום מעוגן במסמך המקור',
        severity: 'must',
        passed: true,
        detail: 'הכל תואם',
      },
    ],
    ungroundedNumbers: [],
    answerTruncated: false,
    draftTruncated: false,
    fenceForgeryDetected: false,
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('verdict-store', () => {
  it('loads null for a job that has no saved verdict', async () => {
    expect(await loadVerdict('job-none', { businessId: BUSINESS })).toBeNull();
  });

  it('round-trips a saved verdict', async () => {
    const verdict = aVerdict();
    await saveVerdict('job-1', verdict, { businessId: BUSINESS });
    expect(await loadVerdict('job-1', { businessId: BUSINESS })).toEqual(verdict);
  });

  it('replaces the earlier verdict on a second save for the same job', async () => {
    await saveVerdict('job-2', aVerdict({ ungroundedNumbers: ['12500'] }), { businessId: BUSINESS });
    const second = aVerdict({
      criteria: [
        {
          id: 'c1',
          statement: 'הסכום מעוגן במסמך המקור',
          severity: 'must',
          passed: false,
          detail: 'נמצא סכום לא מעוגן',
        },
      ],
      ungroundedNumbers: [],
    });
    await saveVerdict('job-2', second, { businessId: BUSINESS });

    expect(await loadVerdict('job-2', { businessId: BUSINESS })).toEqual(second);
  });

  it('scopes verdicts to the business', async () => {
    await saveVerdict('job-3', aVerdict(), { businessId: BUSINESS });
    expect(await loadVerdict('job-3', { businessId: 'other-business' })).toBeNull();
  });

  /**
   * `toVerdict` calls `Verdict.parse`, not `safeParse` — a bare `z.boolean()`
   * on a field added after this table already held rows would make
   * `loadVerdict` THROW on every one of them instead of returning it. Writes
   * directly to the table, bypassing `saveVerdict`'s `Verdict`-typed
   * parameter, to reproduce exactly the row shape a version of the code
   * before `answerTruncated`/`draftTruncated`/`fenceForgeryDetected` existed
   * would have saved.
   *
   * `fenceForgeryDetected` reads back `undefined`, not `false` — it is
   * `.optional()`, deliberately not defaulted (see the schema's own
   * docblock): "cannot be read" must stay distinguishable from "checked, and
   * clean" for a security signal, the two truncation flags being a different
   * case where a default is fine.
   */
  it('reads back a row saved before answerTruncated, draftTruncated and fenceForgeryDetected existed', async () => {
    const oldShapeVerdict = {
      criteria: [
        { id: 'c1', statement: 'x', severity: 'must', passed: true, detail: 'y' },
      ],
      ungroundedNumbers: [],
    };
    await getPool().query(
      `INSERT INTO verification_verdicts (business_id, job_id, verdict) VALUES ($1, $2, $3)`,
      [BUSINESS, 'job-old-shape', JSON.stringify(oldShapeVerdict)],
    );

    const loaded = await loadVerdict('job-old-shape', { businessId: BUSINESS });
    expect(loaded).not.toBeNull();
    expect(loaded?.answerTruncated).toBe(false);
    expect(loaded?.draftTruncated).toBe(false);
    expect(loaded?.fenceForgeryDetected).toBeUndefined();
  });

  it('records a verification that was attempted and did not complete', async () => {
    await saveNotJudged('JOB-1', 'timeout', { businessId: BUSINESS });
    const outcome = await loadVerificationOutcome('JOB-1', { businessId: BUSINESS });
    expect(outcome).toEqual({ status: 'not_judged', reason: 'timeout' });
  });

  it('reports no row at all as null — the state that means "still running"', async () => {
    expect(await loadVerificationOutcome('JOB-NONE', { businessId: BUSINESS })).toBeNull();
  });

  it('a real verdict written over a not-judged row clears the reason, and vice versa', async () => {
    // Both writers upsert the same primary key. Without each clearing the
    // other's column the CHECK rejects the second write, which would surface
    // as a raw Postgres error on a path that should simply overwrite.
    await saveNotJudged('JOB-2', 'failed', { businessId: BUSINESS });
    await saveVerdict('JOB-2', aVerdict(), { businessId: BUSINESS });
    expect(await loadVerificationOutcome('JOB-2', { businessId: BUSINESS })).toEqual({
      status: 'judged',
      verdict: expect.objectContaining({ criteria: expect.any(Array) }),
    });

    await saveNotJudged('JOB-2', 'timeout', { businessId: BUSINESS });
    expect(await loadVerificationOutcome('JOB-2', { businessId: BUSINESS })).toEqual({
      status: 'not_judged',
      reason: 'timeout',
    });
  });

  it('loadVerdict returns null for a not-judged row instead of throwing', async () => {
    // `toVerdict` calls `Verdict.parse`. Before this change the column was NOT
    // NULL, so the parse always had an object; a not-judged row would hand it
    // `null` and throw — and the dashboard route wraps `loadVerdict` in a
    // try/catch that renders "a verdict exists but could not be read", which
    // would be a lie about a row that says the judge never ran.
    await saveNotJudged('JOB-3', 'failed', { businessId: BUSINESS });
    expect(await loadVerdict('JOB-3', { businessId: BUSINESS })).toBeNull();
  });

  it('refuses a reason outside the enum at the database, not only in zod', async () => {
    await expect(
      getPool().query(
        `INSERT INTO verification_verdicts (business_id, job_id, verdict, not_judged_reason)
         VALUES ($1, $2, NULL, 'whatever')`,
        [BUSINESS, 'JOB-4'],
      ),
    ).rejects.toThrow(/verification_verdicts_one_shape/);
  });
});
