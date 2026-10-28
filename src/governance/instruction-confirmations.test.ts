import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import type { Plan } from '../domain/plan.js';
import {
  cancelConfirmation,
  claimConfirmedStep,
  confirmChoice,
  createConfirmation,
  expireConfirmations,
  loadConfirmation,
  type ConfirmationOption,
} from './instruction-confirmations.js';

const BUSINESS = 'test-business';
const OTHER = 'other-business';

function planTo(address: string): Plan {
  return {
    goal: `מייל אל ${address}`,
    assumptions: [],
    clarifyingQuestion: null,
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'send',
        toolName: 'mail.send',
        input: { to: address, subject: 'שלום', body: 'תוכן מלא' },
        dependsOn: [],
        expectedActionClass: 'email.initiate',
      },
    ],
    estimatedCostMinor: 0,
  };
}

const OPTION_A: ConfirmationOption = {
  label: 'דנה כהן',
  planHash: 'hash-a',
  plan: planTo('dana@a.example'),
  contactSource: 'boss',
};
const OPTION_B: ConfirmationOption = {
  label: 'דנה לוי',
  planHash: 'hash-b',
  plan: planTo('dana@b.example'),
  contactSource: 'unverified',
};

async function seed(jobId: string, businessId = BUSINESS, options = [OPTION_A, OPTION_B]): Promise<void> {
  await createConfirmation(
    { jobId, options, presentedText: 'לשלוח? 1. דנה כהן 2. דנה לוי', channel: 'whatsapp' },
    { businessId },
  );
}

async function stateOf(jobId: string, businessId: string): Promise<string | undefined> {
  const { rows } = await getPool().query<{ state: string }>(
    'SELECT state FROM instruction_confirmations WHERE business_id = $1 AND job_id = $2',
    [businessId, jobId],
  );
  return rows[0]?.state;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('instruction confirmations', () => {
  it('round-trips a created confirmation', async () => {
    await createConfirmation(
      { jobId: 'J1', options: [OPTION_A], presentedText: 'לשלוח?', channel: 'dashboard', reaskOf: 'J0' },
      { businessId: BUSINESS },
    );
    const loaded = await loadConfirmation('J1', { businessId: BUSINESS });
    expect(loaded).not.toBeNull();
    expect(loaded?.jobId).toBe('J1');
    expect(loaded?.options).toEqual([OPTION_A]);
    expect(loaded?.presentedText).toBe('לשלוח?');
    expect(loaded?.presentedAt).toBeInstanceOf(Date);
    expect(loaded?.channel).toBe('dashboard');
    expect(loaded?.state).toBe('pending');
    expect(loaded?.chosenPlanHash).toBeNull();
    expect(loaded?.decidedAt).toBeNull();
    expect(loaded?.decidedBy).toBeNull();
    expect(loaded?.reaskOf).toBe('J0');

    expect(await loadConfirmation('J1', { businessId: OTHER })).toBeNull();
    expect(await loadConfirmation('missing', { businessId: BUSINESS })).toBeNull();
  });

  it('confirms once: the second confirmChoice returns false and changes nothing', async () => {
    await seed('J1');
    expect(await confirmChoice('J1', 'hash-b', 'owner', { businessId: BUSINESS })).toBe(true);
    expect(await confirmChoice('J1', 'hash-a', 'owner', { businessId: BUSINESS })).toBe(false);

    const loaded = await loadConfirmation('J1', { businessId: BUSINESS });
    expect(loaded?.state).toBe('confirmed');
    expect(loaded?.chosenPlanHash).toBe('hash-b');
    expect(loaded?.decidedBy).toBe('owner');
    expect(loaded?.decidedAt).toBeInstanceOf(Date);
  });

  it('refuses a hash that is not among the options', async () => {
    await seed('J1');
    expect(await confirmChoice('J1', 'hash-zz', 'owner', { businessId: BUSINESS })).toBe(false);
    expect(await stateOf('J1', BUSINESS)).toBe('pending');
  });

  it('cannot cancel after confirm, and cancels a pending row once', async () => {
    await seed('J1');
    expect(await confirmChoice('J1', 'hash-a', 'owner', { businessId: BUSINESS })).toBe(true);
    expect(await cancelConfirmation('J1', 'owner', { businessId: BUSINESS })).toBe(false);
    expect(await stateOf('J1', BUSINESS)).toBe('confirmed');

    await seed('J2');
    expect(await cancelConfirmation('J2', 'owner', { businessId: BUSINESS })).toBe(true);
    expect(await cancelConfirmation('J2', 'owner', { businessId: BUSINESS })).toBe(false);
    expect(await confirmChoice('J2', 'hash-a', 'owner', { businessId: BUSINESS })).toBe(false);
    const loaded = await loadConfirmation('J2', { businessId: BUSINESS });
    expect(loaded?.state).toBe('cancelled');
    expect(loaded?.chosenPlanHash).toBeNull();
    expect(loaded?.decidedBy).toBe('owner');
  });

  it('expires only pending rows older than the window, and returns their job ids', async () => {
    await seed('OLD');
    await seed('FRESH');
    await seed('OLD-CONFIRMED');
    await seed('OLD-OTHER', OTHER);
    expect(await confirmChoice('OLD-CONFIRMED', 'hash-a', 'owner', { businessId: BUSINESS })).toBe(true);
    await getPool().query(
      `UPDATE instruction_confirmations SET presented_at = now() - interval '2 hours'
        WHERE job_id IN ('OLD', 'OLD-CONFIRMED', 'OLD-OTHER')`,
    );

    const expired = await expireConfirmations({ businessId: BUSINESS, windowMinutes: 30 });
    expect(expired).toEqual(['OLD']);
    expect(await stateOf('OLD', BUSINESS)).toBe('expired');
    expect(await stateOf('FRESH', BUSINESS)).toBe('pending');
    expect(await stateOf('OLD-CONFIRMED', BUSINESS)).toBe('confirmed');
    expect(await stateOf('OLD-OTHER', OTHER)).toBe('pending');

    // Already expired: not returned twice.
    expect(await expireConfirmations({ businessId: BUSINESS, windowMinutes: 30 })).toEqual([]);
  });

  it('measures the window against `now`, not the wall clock', async () => {
    await seed('J1');
    expect(await expireConfirmations({ businessId: BUSINESS, windowMinutes: 30 })).toEqual([]);
    const later = new Date(Date.now() + 31 * 60_000);
    expect(await expireConfirmations({ businessId: BUSINESS, windowMinutes: 30, now: later })).toEqual(['J1']);
  });

  it('never expires anything when the window is 0', async () => {
    await seed('J1');
    const muchLater = new Date(Date.now() + 365 * 24 * 60 * 60_000);
    expect(await expireConfirmations({ businessId: BUSINESS, windowMinutes: 0, now: muchLater })).toEqual([]);
    expect(await stateOf('J1', BUSINESS)).toBe('pending');
  });

  it('claims a step once: the second claim returns false', async () => {
    const input = { jobId: 'J1', stepId: 's1', planHash: 'hash-a' };
    expect(await claimConfirmedStep(input, { businessId: BUSINESS })).toBe(true);
    expect(await claimConfirmedStep(input, { businessId: BUSINESS })).toBe(false);
    expect(await claimConfirmedStep({ ...input, stepId: 's2' }, { businessId: BUSINESS })).toBe(true);
  });

  it('scopes every function by business: a same-job-id row in another business is untouched', async () => {
    await seed('J1', BUSINESS);
    await seed('J1', OTHER);

    expect(await confirmChoice('J1', 'hash-a', 'owner', { businessId: OTHER })).toBe(true);
    expect(await stateOf('J1', BUSINESS)).toBe('pending');
    expect((await loadConfirmation('J1', { businessId: BUSINESS }))?.chosenPlanHash).toBeNull();

    await seed('J2', BUSINESS);
    await seed('J2', OTHER);
    expect(await cancelConfirmation('J2', 'owner', { businessId: OTHER })).toBe(true);
    expect(await stateOf('J2', BUSINESS)).toBe('pending');

    // A confirm in a business that has no such job flips nothing anywhere.
    await seed('J3', BUSINESS);
    expect(await confirmChoice('J3', 'hash-a', 'owner', { businessId: OTHER })).toBe(false);
    expect(await stateOf('J3', BUSINESS)).toBe('pending');

    // Claims in two businesses for the same job/step are independent.
    const claim = { jobId: 'J1', stepId: 's1', planHash: 'hash-a' };
    expect(await claimConfirmedStep(claim, { businessId: OTHER })).toBe(true);
    expect(await claimConfirmedStep(claim, { businessId: BUSINESS })).toBe(true);
  });

  it('the database refuses a confirmed row without a chosen hash', async () => {
    await seed('J1');
    await expect(
      getPool().query(`UPDATE instruction_confirmations SET state = 'confirmed' WHERE job_id = 'J1'`),
    ).rejects.toThrow(/chosen_iff_confirmed/);
  });
});
