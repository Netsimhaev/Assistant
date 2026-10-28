import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import type { Plan } from '../domain/plan.js';
import { planHashOf } from '../orchestrator/plan-store.js';
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

const PLAN_A = planTo('dana@a.example');
const PLAN_B = planTo('dana@b.example');
const HASH_A = planHashOf(PLAN_A);
const HASH_B = planHashOf(PLAN_B);

const OPTION_A: ConfirmationOption = { label: 'דנה כהן', planHash: HASH_A, plan: PLAN_A, contactSource: 'boss' };
const OPTION_B: ConfirmationOption = { label: 'דנה לוי', planHash: HASH_B, plan: PLAN_B, contactSource: 'unverified' };

async function presentedMinutesAgo(jobId: string, minutes: number): Promise<void> {
  await getPool().query(
    `UPDATE instruction_confirmations SET presented_at = now() - make_interval(mins => $2) WHERE job_id = $1`,
    [jobId, minutes],
  );
}

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
    expect(await confirmChoice('J1', HASH_B, 'owner', { businessId: BUSINESS })).toBe(true);
    expect(await confirmChoice('J1', HASH_A, 'owner', { businessId: BUSINESS })).toBe(false);

    const loaded = await loadConfirmation('J1', { businessId: BUSINESS });
    expect(loaded?.state).toBe('confirmed');
    expect(loaded?.chosenPlanHash).toBe(HASH_B);
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
    expect(await confirmChoice('J1', HASH_A, 'owner', { businessId: BUSINESS })).toBe(true);
    expect(await cancelConfirmation('J1', 'owner', { businessId: BUSINESS })).toBe(false);
    expect(await stateOf('J1', BUSINESS)).toBe('confirmed');

    await seed('J2');
    expect(await cancelConfirmation('J2', 'owner', { businessId: BUSINESS })).toBe(true);
    expect(await cancelConfirmation('J2', 'owner', { businessId: BUSINESS })).toBe(false);
    expect(await confirmChoice('J2', HASH_A, 'owner', { businessId: BUSINESS })).toBe(false);
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
    expect(await confirmChoice('OLD-CONFIRMED', HASH_A, 'owner', { businessId: BUSINESS })).toBe(true);
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

  it('cannot confirm a question presented outside the window, even before any sweep ran', async () => {
    await seed('STALE');
    await seed('FRESH');
    await presentedMinutesAgo('STALE', 31);
    await presentedMinutesAgo('FRESH', 29);

    expect(await confirmChoice('STALE', HASH_A, 'owner', { businessId: BUSINESS, windowMinutes: 30 })).toBe(false);
    expect(await stateOf('STALE', BUSINESS)).toBe('pending');
    expect(await confirmChoice('FRESH', HASH_A, 'owner', { businessId: BUSINESS, windowMinutes: 30 })).toBe(true);
  });

  it('refuses every confirm when the window is 0, even a question stamped ahead of the clock', async () => {
    await seed('J1');
    expect(await confirmChoice('J1', HASH_A, 'owner', { businessId: BUSINESS, windowMinutes: 0 })).toBe(false);
    expect(await stateOf('J1', BUSINESS)).toBe('pending');

    // A row whose presented_at is ahead of the database clock (written by a
    // skewed writer) would pass `presented_at > now() - 0`; window 0 must
    // still refuse it, so the refusal cannot rest on the time comparison.
    await seed('AHEAD');
    await presentedMinutesAgo('AHEAD', -5);
    expect(await confirmChoice('AHEAD', HASH_A, 'owner', { businessId: BUSINESS, windowMinutes: 0 })).toBe(false);
    expect(await stateOf('AHEAD', BUSINESS)).toBe('pending');
  });

  it('expires every pending row of the business when the window is 0', async () => {
    await seed('J1');
    await seed('J2');
    await seed('J3');
    await seed('J1', OTHER);
    expect(await confirmChoice('J3', HASH_A, 'owner', { businessId: BUSINESS, windowMinutes: 30 })).toBe(true);
    // Stamped ahead of the database clock: window 0 expires it anyway, so
    // "nothing is open" does not rest on the time comparison.
    await presentedMinutesAgo('J2', -5);

    expect(await expireConfirmations({ businessId: BUSINESS, windowMinutes: 0 })).toEqual(['J1', 'J2']);
    expect(await stateOf('J3', BUSINESS)).toBe('confirmed');
    expect(await stateOf('J1', OTHER)).toBe('pending');
    const expired = await loadConfirmation('J1', { businessId: BUSINESS });
    expect(expired?.state).toBe('expired');
    expect(expired?.decidedAt).toBeInstanceOf(Date);
  });

  it('computes each option hash itself: refuses a hash that disagrees with its plan', async () => {
    await expect(
      createConfirmation(
        { jobId: 'J1', options: [{ ...OPTION_A, planHash: HASH_B }], presentedText: 'לשלוח?', channel: 'whatsapp' },
        { businessId: BUSINESS },
      ),
    ).rejects.toThrow(/does not match its plan/);
    expect(await loadConfirmation('J1', { businessId: BUSINESS })).toBeNull();
  });

  it('refuses two options with the same plan hash', async () => {
    await expect(
      createConfirmation(
        { jobId: 'J1', options: [OPTION_A, { ...OPTION_A, label: 'שוב' }], presentedText: 'לשלוח?', channel: 'whatsapp' },
        { businessId: BUSINESS },
      ),
    ).rejects.toThrow(/repeat the same plan/);
    expect(await loadConfirmation('J1', { businessId: BUSINESS })).toBeNull();
  });

  it('claims a step once: the second claim returns false', async () => {
    const input = { jobId: 'J1', stepId: 's1', planHash: HASH_A };
    expect(await claimConfirmedStep(input, { businessId: BUSINESS })).toBe(true);
    expect(await claimConfirmedStep(input, { businessId: BUSINESS })).toBe(false);
    expect(await claimConfirmedStep({ ...input, stepId: 's2' }, { businessId: BUSINESS })).toBe(true);
  });

  it('scopes every function by business: a same-job-id row in another business is untouched', async () => {
    await seed('J1', BUSINESS);
    await seed('J1', OTHER);

    expect(await confirmChoice('J1', HASH_A, 'owner', { businessId: OTHER })).toBe(true);
    expect(await stateOf('J1', BUSINESS)).toBe('pending');
    expect((await loadConfirmation('J1', { businessId: BUSINESS }))?.chosenPlanHash).toBeNull();

    await seed('J2', BUSINESS);
    await seed('J2', OTHER);
    expect(await cancelConfirmation('J2', 'owner', { businessId: OTHER })).toBe(true);
    expect(await stateOf('J2', BUSINESS)).toBe('pending');

    // A confirm in a business that has no such job flips nothing anywhere.
    await seed('J3', BUSINESS);
    expect(await confirmChoice('J3', HASH_A, 'owner', { businessId: OTHER })).toBe(false);
    expect(await stateOf('J3', BUSINESS)).toBe('pending');

    // Claims in two businesses for the same job/step are independent.
    const claim = { jobId: 'J1', stepId: 's1', planHash: HASH_A };
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
