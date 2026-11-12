/**
 * The settle sweep against a concurrent `applyConfirmation` (the dashboard is
 * another process). Each race is reproduced deterministically: `loadStoredPlan`
 * is wrapped so that, right after the sweep's own (now stale) read, the other
 * side's bind and move run to completion. The sweep must then skip the job —
 * never fail one the owner just confirmed, and never report an error.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const race: { afterRead: (() => Promise<void>) | null } = { afterRead: null };

vi.mock('./plan-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plan-store.js')>();
  return {
    ...actual,
    loadStoredPlan: async (...args: Parameters<typeof actual.loadStoredPlan>) => {
      const read = await actual.loadStoredPlan(...args);
      const hook = race.afterRead;
      if (hook !== null) {
        race.afterRead = null;
        await hook();
      }
      return read;
    },
  };
});

import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, TEST_BUSINESS, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { Plan } from '../domain/plan.js';
import { saveInstruction } from '../governance/instructions.js';
import {
  cancelConfirmation,
  confirmChoice,
  createConfirmation,
  type ConfirmationOption,
} from '../governance/instruction-confirmations.js';
import { PhaseMovedError, createJob, loadJob, transition } from './jobs.js';
import { bindPlanToJob, planHashOf } from './plan-store.js';
import { bindChosenPlan, settleDecidedConfirmations } from './command-confirm.js';

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
        input: { to: address, subject: 'תזכורת', body: 'שלום' },
        dependsOn: [],
        expectedActionClass: 'email.initiate',
      },
    ],
    estimatedCostMinor: 0,
  };
}

const PLAN_A = planTo('dana@chayut.example');
const PLAN_B = planTo('dana.levi@x.example');
const HASH_A = planHashOf(PLAN_A);
const HASH_B = planHashOf(PLAN_B);
const OPTION_A: ConfirmationOption = {
  label: 'דנה חיוט',
  planHash: HASH_A,
  plan: PLAN_A,
  contactSource: 'boss',
  contactName: 'דנה חיוט',
};
const OPTION_B: ConfirmationOption = {
  label: 'דנה לוי',
  planHash: HASH_B,
  plan: PLAN_B,
  contactSource: 'boss',
  contactName: 'דנה לוי',
};
const SINGLE: ConfirmationOption = { label: 'לבצע?', planHash: HASH_A, plan: PLAN_A, contactSource: null };

const versions = new Map<string, string>();

async function parkedJob(options: ConfirmationOption[], businessId = BUSINESS): Promise<string> {
  let version = versions.get(businessId);
  if (version === undefined) {
    version = (await withBusiness(businessId, (bdb) => installCharter(bdb, buildCharter()))).charterVersion;
    versions.set(businessId, version);
  }
  const job = await withBusiness(businessId, (db) => createJob(db, { charterVersion: version, provenance: 'boss' }));
  await withBusiness(businessId, (bdb) => saveInstruction(bdb, { jobId: job.jobId, text: 'תשלחי לדנה', textOrigin: 'typed' }));
  await withBusiness(businessId, (db) => transition(db, job.jobId, { to: 'understand', actor: 'orchestrator', reason: 't' }));
  await withBusiness(businessId, (db) => transition(db, job.jobId, { to: 'plan', actor: 'orchestrator', reason: 't' }));
  await withBusiness(businessId, (bdb) => createConfirmation(bdb, { jobId: job.jobId, options, presentedText: 'שאלה', channel: 'whatsapp' }));
  return job.jobId;
}

async function phaseOf(jobId: string, businessId = BUSINESS): Promise<string | undefined> {
  return (await withBusiness(businessId, (db) => loadJob(db, jobId)))?.phase;
}

async function stepsTo(jobId: string, to: string): Promise<number> {
  const { rows } = await testDb().query('SELECT 1 FROM job_steps WHERE job_id = $1 AND to_phase = $2', [
    jobId,
    to,
  ]);
  return rows.length;
}


beforeEach(async () => {
  await resetDatabase();
  versions.clear();
  race.afterRead = null;
});

afterAll(async () => {
  await closePool();
});

describe('the settle sweep loses a race to the owner', () => {
  it('several options: the owner binds and executes after the sweep read nothing bound — skipped, never failed', async () => {
    const jobId = await parkedJob([OPTION_A, OPTION_B]);
    expect(await withBusiness(BUSINESS, (bdb) => confirmChoice(bdb, jobId, HASH_A, 'owner'))).toBe(true);
    race.afterRead = async () => {
      // applyConfirmation's second half, from the dashboard.
      await withBusiness(TEST_BUSINESS, (db) => bindChosenPlan(db, jobId, HASH_A));
      await withBusiness(BUSINESS, (db) => transition(db, jobId, { to: 'execute', actor: 'human', reason: 'command: confirmed' }));
    };

    expect(await withBusiness(TEST_BUSINESS, (db) => settleDecidedConfirmations(db))).toEqual({ settled: [], skipped: [jobId], errored: [] });
    expect(race.afterRead).toBeNull();
    expect(await phaseOf(jobId)).toBe('execute');
    expect(await stepsTo(jobId, 'failed')).toBe(0);
  });

  it('single option, nothing bound at the read: the owner binds and executes — skipped, never failed', async () => {
    const jobId = await parkedJob([SINGLE]);
    expect(await withBusiness(BUSINESS, (bdb) => confirmChoice(bdb, jobId, HASH_A, 'owner'))).toBe(true);
    race.afterRead = async () => {
      await withBusiness(TEST_BUSINESS, (db) => bindPlanToJob(db, jobId, PLAN_A));
      await withBusiness(BUSINESS, (db) => transition(db, jobId, { to: 'execute', actor: 'human', reason: 'command: confirmed' }));
    };

    expect(await withBusiness(TEST_BUSINESS, (db) => settleDecidedConfirmations(db))).toEqual({ settled: [], skipped: [jobId], errored: [] });
    expect(await phaseOf(jobId)).toBe('execute');
    expect(await stepsTo(jobId, 'failed')).toBe(0);
  });

  it('single option, bound: the owner moves it to execute first — skipped quietly, not errored', async () => {
    const jobId = await parkedJob([SINGLE]);
    await withBusiness(TEST_BUSINESS, (db) => bindPlanToJob(db, jobId, PLAN_A));
    expect(await withBusiness(BUSINESS, (bdb) => confirmChoice(bdb, jobId, HASH_A, 'owner'))).toBe(true);
    race.afterRead = async () => {
      await withBusiness(BUSINESS, (db) => transition(db, jobId, { to: 'execute', actor: 'human', reason: 'command: confirmed' }));
    };

    expect(await withBusiness(TEST_BUSINESS, (db) => settleDecidedConfirmations(db))).toEqual({ settled: [], skipped: [jobId], errored: [] });
    expect(await stepsTo(jobId, 'execute')).toBe(1);
  });
});

describe('the settle sweep stays in its own business', () => {
  it('leaves another business decided confirmation untouched', async () => {
    const mine = await parkedJob([SINGLE]);
    await withBusiness(BUSINESS, (bdb) => cancelConfirmation(bdb, mine, 'owner'));
    const theirs = await parkedJob([SINGLE], OTHER);
    await withBusiness(OTHER, (bdb) => cancelConfirmation(bdb, theirs, 'owner'));

    expect(await withBusiness(TEST_BUSINESS, (db) => settleDecidedConfirmations(db))).toEqual({
      settled: [{ jobId: mine, to: 'closed' }],
      skipped: [],
      errored: [],
    });
    expect(await phaseOf(theirs, OTHER)).toBe('plan');
  });
});

describe('transition expectFrom', () => {
  it('moves only from the expected phase, and writes nothing otherwise', async () => {
    const jobId = await parkedJob([SINGLE]);
    await expect(
      withBusiness(BUSINESS, (db) => transition(db, jobId, { to: 'closed', actor: 'system', reason: 'x', expectFrom: 'execute' })),
    ).rejects.toBeInstanceOf(PhaseMovedError);
    expect(await phaseOf(jobId)).toBe('plan');
    expect(await stepsTo(jobId, 'closed')).toBe(0);

    await withBusiness(BUSINESS, (db) => transition(db, jobId, { to: 'closed', actor: 'system', reason: 'x', expectFrom: 'plan' }));
    expect(await phaseOf(jobId)).toBe('closed');
  });
});
