import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { loadVerdict, saveVerdict } from './verdict-store.js';
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
});
