import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { Plan } from '../domain/plan.js';
import { CLOSURE_VERB_WORDS } from '../governance/closure-command.js';
import { FORGET_VERBS } from '../governance/forget-command.js';
import { saveInstruction } from '../governance/instructions.js';
import {
  cancelConfirmation,
  confirmChoice,
  createConfirmation,
  expireConfirmations,
  loadConfirmation,
  type ConfirmationOption,
} from '../governance/instruction-confirmations.js';
import { createJob, loadJob, transition } from './jobs.js';
import { bindPlanToJob, loadStoredPlan, planHashOf } from './plan-store.js';
import { MAIL_CARD_APPROVE_WORDS } from './whatsapp-mail-card.js';
import { schedulerPass } from './scheduler.js';
import type { Runtime } from './runtime.js';
import { AdapterRegistry } from './adapters/registry.js';
import { envCredentials } from './credentials.js';
import {
  CANCEL_WORDS,
  CONFIRM_WORDS,
  applyConfirmation,
  UNAPPLIABLE_REASON,
  bindChosenPlan,
  openConfirmations,
  readConfirmation,
  settleDecidedConfirmations,
} from './command-confirm.js';

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
const PLAN_C = planTo('other@y.example');
const HASH_A = planHashOf(PLAN_A);
const HASH_B = planHashOf(PLAN_B);

const OPTION_A: ConfirmationOption = {
  label: 'דנה חיוט (חיוט בע"מ · dana@chayut.example)',
  planHash: HASH_A,
  plan: PLAN_A,
  contactSource: 'boss',
  contactName: 'דנה חיוט',
};
const OPTION_B: ConfirmationOption = {
  label: 'דנה לוי (dana.levi@x.example)',
  planHash: HASH_B,
  plan: PLAN_B,
  contactSource: 'boss',
  contactName: 'דנה לוי',
};
const SINGLE: ConfirmationOption = {
  label: 'לבצע את הפעולות הבאות?',
  planHash: HASH_A,
  plan: PLAN_A,
  contactSource: null,
};

const versions = new Map<string, string>();

/** One installed charter per business — jobs reference its version. */
async function charterVersion(businessId: string): Promise<string> {
  const known = versions.get(businessId);
  if (known !== undefined) return known;
  const bundle = await installCharter(buildCharter(), { businessId });
  versions.set(businessId, bundle.charterVersion);
  return bundle.charterVersion;
}

/** A boss job parked in `plan` with an instruction row, the shape `runInstruction` leaves. */
async function parkedJob(businessId = BUSINESS): Promise<string> {
  const job = await createJob({ charterVersion: await charterVersion(businessId), provenance: 'boss', businessId });
  await saveInstruction(
    { jobId: job.jobId, text: 'תשלחי לדנה תזכורת', textOrigin: 'typed' },
    { businessId },
  );
  await transition(job.jobId, { to: 'understand', actor: 'orchestrator', reason: 't', businessId });
  await transition(job.jobId, { to: 'plan', actor: 'orchestrator', reason: 't', businessId });
  return job.jobId;
}

async function ask(
  jobId: string,
  options: ConfirmationOption[],
  extra: { businessId?: string; channel?: 'whatsapp' | 'dashboard' } = {},
): Promise<void> {
  await createConfirmation(
    { jobId, options, presentedText: 'שאלה', channel: extra.channel ?? 'whatsapp' },
    { businessId: extra.businessId ?? BUSINESS },
  );
}

async function presentedAt(jobId: string, at: Date): Promise<void> {
  await getPool().query('UPDATE instruction_confirmations SET presented_at = $2 WHERE job_id = $1', [
    jobId,
    at,
  ]);
}

async function phaseOf(jobId: string, businessId = BUSINESS): Promise<string | undefined> {
  return (await loadJob(jobId, { businessId }))?.phase;
}

async function transitionsTo(jobId: string, to: string): Promise<number> {
  const { rows } = await getPool().query(
    'SELECT 1 FROM job_steps WHERE job_id = $1 AND to_phase = $2',
    [jobId, to],
  );
  return rows.length;
}

async function tamperFirstOption(jobId: string): Promise<void> {
  await getPool().query(
    `UPDATE instruction_confirmations
        SET options = jsonb_set(options, '{0,plan,goal}', '"tampered"')
      WHERE job_id = $1`,
    [jobId],
  );
}

function inertRuntime(): Runtime {
  return {
    registry: new AdapterRegistry([]),
    credentials: envCredentials({}, 'TEST_CRED_'),
    warnings: [],
  };
}

async function reasonsTo(jobId: string, to: string): Promise<string[]> {
  const { rows } = await getPool().query<{ reason: string }>(
    'SELECT reason FROM job_steps WHERE job_id = $1 AND to_phase = $2',
    [jobId, to],
  );
  return rows.map((r) => r.reason);
}

beforeEach(async () => {
  await resetDatabase();
  versions.clear();
});

afterAll(async () => {
  await closePool();
});

describe('word lists', () => {
  it('confirm and cancel words are disjoint from each other, the forget verbs and the mail-card words', () => {
    const lists: Array<[string, readonly string[]]> = [
      ['CONFIRM_WORDS', CONFIRM_WORDS],
      ['CANCEL_WORDS', CANCEL_WORDS],
      ['FORGET_VERBS', FORGET_VERBS],
      ['MAIL_CARD_APPROVE_WORDS', MAIL_CARD_APPROVE_WORDS],
    ];
    for (let i = 0; i < lists.length; i++) {
      for (let j = i + 1; j < lists.length; j++) {
        const [nameA, a] = lists[i]!;
        const [nameB, b] = lists[j]!;
        const shared = a.filter((word) => b.includes(word));
        expect(shared, `${nameA} ∩ ${nameB}`).toEqual([]);
      }
    }
    expect(CONFIRM_WORDS.filter((word) => CLOSURE_VERB_WORDS.includes(word))).toEqual([]);
  });

  it('cancel words are "לא" plus every closure verb, taken from the exported list', () => {
    expect(CANCEL_WORDS).toEqual(['לא', ...CLOSURE_VERB_WORDS]);
  });
});

describe('readConfirmation', () => {
  it('a confirm word confirms the only option', () => {
    expect(readConfirmation('כן', [SINGLE])).toEqual({ kind: 'confirm', planHash: HASH_A });
    expect(readConfirmation('  ‏מאשרת‎ ', [SINGLE])).toEqual({
      kind: 'confirm',
      planHash: HASH_A,
    });
  });

  it('a confirm word with two options is unclear — it does not say which', () => {
    expect(readConfirmation('כן', [OPTION_A, OPTION_B])).toEqual({ kind: 'unclear' });
  });

  it('a confirm word inside a sentence is not a confirmation', () => {
    expect(readConfirmation('כן תשלחי גם לרונית', [SINGLE])).toEqual({ kind: 'none' });
  });

  it('only a canonical number picks: "01" does not', () => {
    expect(readConfirmation('01', [OPTION_A, OPTION_B])).toEqual({ kind: 'unclear' });
    expect(readConfirmation('01', [SINGLE])).toEqual({ kind: 'unclear' });
  });

  it('a message of punctuation alone names nobody', () => {
    expect(readConfirmation('?!', [OPTION_A])).toEqual({ kind: 'none' });
    expect(readConfirmation('. ,', [OPTION_A, OPTION_B])).toEqual({ kind: 'none' });
  });

  it('a one-letter token is never a name', () => {
    const ad: ConfirmationOption = { ...OPTION_A, contactName: 'א דנה' };
    expect(readConfirmation('א', [ad, OPTION_B])).toEqual({ kind: 'none' });
  });

  it('a first name alone never selects, even when only one option carries it', () => {
    const ronit: ConfirmationOption = { ...OPTION_B, contactName: 'רונית לוי' };
    expect(readConfirmation('דנה', [OPTION_A, ronit])).toEqual({ kind: 'unclear' });
  });

  it('the full name in either order selects', () => {
    expect(readConfirmation('חיוט דנה', [OPTION_A, OPTION_B])).toEqual({ kind: 'confirm', planHash: HASH_A });
  });

  it('a surname that is also an ordinary word selects (accepted, see the report)', () => {
    const tov: ConfirmationOption = { ...OPTION_A, contactName: 'דנה טוב' };
    expect(readConfirmation('טוב', [tov, OPTION_B])).toEqual({ kind: 'confirm', planHash: HASH_A });
  });

  it('a number picks that option, and one out of range is unclear', () => {
    expect(readConfirmation('2', [OPTION_A, OPTION_B])).toEqual({ kind: 'confirm', planHash: HASH_B });
    expect(readConfirmation('1', [OPTION_A, OPTION_B])).toEqual({ kind: 'confirm', planHash: HASH_A });
    expect(readConfirmation('3', [OPTION_A, OPTION_B])).toEqual({ kind: 'unclear' });
    expect(readConfirmation('0', [OPTION_A, OPTION_B])).toEqual({ kind: 'unclear' });
  });

  it('a full name or a surname that belongs to one option picks it', () => {
    expect(readConfirmation('דנה חיוט', [OPTION_A, OPTION_B])).toEqual({
      kind: 'confirm',
      planHash: HASH_A,
    });
    expect(readConfirmation('חיוט', [OPTION_A, OPTION_B])).toEqual({ kind: 'confirm', planHash: HASH_A });
    expect(readConfirmation('לוי', [OPTION_A, OPTION_B])).toEqual({ kind: 'confirm', planHash: HASH_B });
  });

  it('a name that two options share is unclear', () => {
    expect(readConfirmation('דנה', [OPTION_A, OPTION_B])).toEqual({ kind: 'unclear' });
  });

  it('a name is never parsed out of the label (the address is not a name)', () => {
    expect(readConfirmation('dana@chayut.example', [OPTION_A, OPTION_B])).toEqual({ kind: 'none' });
  });

  it('"לא" and a closure word cancel', () => {
    expect(readConfirmation('לא', [OPTION_A, OPTION_B])).toEqual({ kind: 'cancel' });
    expect(readConfirmation('סגרנו', [SINGLE])).toEqual({ kind: 'cancel' });
  });

  it('anything else is not an answer to this question', () => {
    expect(readConfirmation('תזמיני לי מונית', [OPTION_A, OPTION_B])).toEqual({ kind: 'none' });
    expect(readConfirmation('   ', [SINGLE])).toEqual({ kind: 'none' });
    expect(readConfirmation('שלח', [SINGLE])).toEqual({ kind: 'none' });
  });
});

describe('openConfirmations', () => {
  it('returns a pending WhatsApp question presented before the message, inside the window', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [SINGLE]);
    await presentedAt(jobId, new Date(Date.now() - 60_000));
    const open = await openConfirmations({ businessId: BUSINESS, channel: 'whatsapp', inboundAt: new Date() });
    expect(open.map((c) => c.jobId)).toEqual([jobId]);
  });

  it('excludes a question presented after (or at) the message, and an unreadable timestamp', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [SINGLE]);
    const shown = new Date(Date.now() - 60_000);
    await presentedAt(jobId, shown);
    const before = new Date(shown.getTime() - 1_000);
    expect(await openConfirmations({ businessId: BUSINESS, channel: 'whatsapp', inboundAt: before })).toEqual([]);
    expect(await openConfirmations({ businessId: BUSINESS, channel: 'whatsapp', inboundAt: shown })).toEqual([]);
    expect(await openConfirmations({ businessId: BUSINESS, channel: 'whatsapp', inboundAt: null })).toEqual([]);
  });

  it('excludes a question presented outside the window', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [SINGLE]);
    await presentedAt(jobId, new Date(Date.now() - 31 * 60_000));
    expect(
      await openConfirmations({ businessId: BUSINESS, channel: 'whatsapp', inboundAt: new Date() }),
    ).toEqual([]);
  });

  it('excludes other businesses, other channels, decided rows, jobs out of plan and jobs without an instruction', async () => {
    const minuteAgo = new Date(Date.now() - 60_000);

    const otherBusiness = await parkedJob(OTHER);
    await ask(otherBusiness, [SINGLE], { businessId: OTHER });

    const dashboard = await parkedJob();
    await ask(dashboard, [SINGLE], { channel: 'dashboard' });

    const cancelled = await parkedJob();
    await ask(cancelled, [SINGLE]);
    await getPool().query(
      "UPDATE instruction_confirmations SET state = 'cancelled', decided_at = now() WHERE job_id = $1",
      [cancelled],
    );

    const movedOn = await parkedJob();
    await ask(movedOn, [SINGLE]);
    await transition(movedOn, { to: 'closed', actor: 'system', reason: 't', businessId: BUSINESS });

    const noInstruction = (
      await createJob({ charterVersion: await charterVersion(BUSINESS), provenance: 'boss', businessId: BUSINESS })
    ).jobId;
    await transition(noInstruction, { to: 'understand', actor: 'orchestrator', reason: 't', businessId: BUSINESS });
    await transition(noInstruction, { to: 'plan', actor: 'orchestrator', reason: 't', businessId: BUSINESS });
    await ask(noInstruction, [SINGLE]);

    for (const jobId of [otherBusiness, dashboard, cancelled, movedOn, noInstruction]) {
      await presentedAt(jobId, minuteAgo);
    }
    expect(
      await openConfirmations({ businessId: BUSINESS, channel: 'whatsapp', inboundAt: new Date() }),
    ).toEqual([]);
  });
});

describe('applyConfirmation', () => {
  it('a single option: confirms, keeps the bound plan, moves plan → execute', async () => {
    const jobId = await parkedJob();
    await bindPlanToJob(jobId, PLAN_A, { businessId: BUSINESS });
    await ask(jobId, [SINGLE]);

    const outcome = await applyConfirmation(jobId, { kind: 'confirm', planHash: HASH_A }, 'owner', {
      businessId: BUSINESS,
    });
    expect(outcome).toBe('executing');
    expect(await phaseOf(jobId)).toBe('execute');
    expect((await loadConfirmation(jobId, { businessId: BUSINESS }))?.state).toBe('confirmed');
    const { rows } = await getPool().query<{ reason: string }>(
      "SELECT reason FROM job_steps WHERE job_id = $1 AND to_phase = 'execute'",
      [jobId],
    );
    expect(rows.map((r) => r.reason)).toEqual(['command: confirmed']);
  });

  it('several options: binds the chosen plan only after the pick', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [OPTION_A, OPTION_B]);
    expect(await loadStoredPlan(jobId, { businessId: BUSINESS })).toBeNull();

    const outcome = await applyConfirmation(jobId, readConfirmation('לוי', [OPTION_A, OPTION_B]), 'owner', {
      businessId: BUSINESS,
    });
    expect(outcome).toBe('executing');
    expect((await loadStoredPlan(jobId, { businessId: BUSINESS }))?.planHash).toBe(HASH_B);
    expect(await phaseOf(jobId)).toBe('execute');
  });

  it('a second confirm is a no-op: already_decided, one transition', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [OPTION_A, OPTION_B]);
    const by = { businessId: BUSINESS };
    expect(await applyConfirmation(jobId, { kind: 'confirm', planHash: HASH_A }, 'owner', by)).toBe('executing');
    expect(await applyConfirmation(jobId, { kind: 'confirm', planHash: HASH_B }, 'owner', by)).toBe(
      'already_decided',
    );
    expect(await transitionsTo(jobId, 'execute')).toBe(1);
    expect((await loadStoredPlan(jobId, by))?.planHash).toBe(HASH_A);
  });

  it('a confirm on an expired question is already_decided and moves nothing', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [OPTION_A, OPTION_B]);
    await presentedAt(jobId, new Date(Date.now() - 31 * 60_000));
    expect(
      await applyConfirmation(jobId, { kind: 'confirm', planHash: HASH_A }, 'owner', { businessId: BUSINESS }),
    ).toBe('already_decided');
    expect(await phaseOf(jobId)).toBe('plan');
    expect(await loadStoredPlan(jobId, { businessId: BUSINESS })).toBeNull();
  });

  it('refuses to execute when the bound plan is not the chosen one (single option)', async () => {
    const jobId = await parkedJob();
    // The job is bound to a plan the owner was never shown.
    await bindPlanToJob(jobId, PLAN_C, { businessId: BUSINESS });
    await ask(jobId, [SINGLE]);
    await expect(
      applyConfirmation(jobId, { kind: 'confirm', planHash: HASH_A }, 'owner', { businessId: BUSINESS }),
    ).rejects.toThrow(/bound/);
    expect(await phaseOf(jobId)).toBe('plan');
  });

  it('refuses to execute when the chosen plan cannot be bound (several options)', async () => {
    const jobId = await parkedJob();
    // Another plan already bound and a step of it already ran: bindPlanToJob conflicts.
    await bindPlanToJob(jobId, PLAN_C, { businessId: BUSINESS });
    await getPool().query(
      `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, status)
       VALUES ($1, $2, $3, 's1', 'unknown')`,
      [BUSINESS, jobId, planHashOf(PLAN_C)],
    );
    await ask(jobId, [OPTION_A, OPTION_B]);
    await expect(
      applyConfirmation(jobId, { kind: 'confirm', planHash: HASH_A }, 'owner', { businessId: BUSINESS }),
    ).rejects.toThrow(/bound/);
    expect(await phaseOf(jobId)).toBe('plan');
    expect((await loadStoredPlan(jobId, { businessId: BUSINESS }))?.planHash).toBe(planHashOf(PLAN_C));
  });

  it('does not bind when the confirmation row was erased between the confirm and the bind', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [OPTION_A, OPTION_B]);
    expect(await confirmChoice(jobId, HASH_A, 'owner', { businessId: BUSINESS })).toBe(true);
    // Erasure lands between `confirmChoice` and the bind.
    await getPool().query('DELETE FROM instruction_confirmations WHERE job_id = $1', [jobId]);
    await expect(bindChosenPlan(jobId, HASH_A, { businessId: BUSINESS })).rejects.toThrow(
      /no longer confirmed/,
    );
    expect(await loadStoredPlan(jobId, { businessId: BUSINESS })).toBeNull();
  });

  it('does not bind a hash other than the confirmed one', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [OPTION_A, OPTION_B]);
    expect(await confirmChoice(jobId, HASH_A, 'owner', { businessId: BUSINESS })).toBe(true);
    await expect(bindChosenPlan(jobId, HASH_B, { businessId: BUSINESS })).rejects.toThrow(
      /no longer confirmed/,
    );
    expect(await loadStoredPlan(jobId, { businessId: BUSINESS })).toBeNull();
  });

  it('a job no longer in plan is already decided, and its row is not flipped', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [OPTION_A, OPTION_B]);
    await transition(jobId, { to: 'closed', actor: 'system', reason: 't', businessId: BUSINESS });
    const by = { businessId: BUSINESS };
    expect(await applyConfirmation(jobId, { kind: 'confirm', planHash: HASH_A }, 'owner', by)).toBe(
      'already_decided',
    );
    expect(await applyConfirmation(jobId, { kind: 'cancel' }, 'owner', by)).toBe('already_decided');
    expect((await loadConfirmation(jobId, by))?.state).toBe('pending');
  });

  it('refuses to bind when the stored option no longer hashes to its planHash (several options)', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [OPTION_A, OPTION_B]);
    // The stored plan of option 1 changed under its recorded hash: binding it
    // would run bytes the owner was never shown.
    await tamperFirstOption(jobId);
    await expect(
      applyConfirmation(jobId, { kind: 'confirm', planHash: HASH_A }, 'owner', { businessId: BUSINESS }),
    ).rejects.toThrow(/could not be bound/);
    expect(await loadStoredPlan(jobId, { businessId: BUSINESS })).toBeNull();
    expect(await phaseOf(jobId)).toBe('plan');
  });

  it('cancel: closes the job, once', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [OPTION_A, OPTION_B]);
    const by = { businessId: BUSINESS };
    expect(await applyConfirmation(jobId, { kind: 'cancel' }, 'owner', by)).toBe('cancelled');
    expect(await phaseOf(jobId)).toBe('closed');
    expect(await applyConfirmation(jobId, { kind: 'cancel' }, 'owner', by)).toBe('already_decided');
    expect(await applyConfirmation(jobId, { kind: 'confirm', planHash: HASH_A }, 'owner', by)).toBe(
      'already_decided',
    );
    expect(await transitionsTo(jobId, 'closed')).toBe(1);
    const { rows } = await getPool().query<{ reason: string }>(
      "SELECT reason FROM job_steps WHERE job_id = $1 AND to_phase = 'closed'",
      [jobId],
    );
    expect(rows.map((r) => r.reason)).toEqual(['command: cancelled']);
  });

  it('unclear and none change nothing', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [OPTION_A, OPTION_B]);
    const by = { businessId: BUSINESS };
    expect(await applyConfirmation(jobId, { kind: 'unclear' }, 'owner', by)).toBe('unclear');
    expect(await applyConfirmation(jobId, { kind: 'none' }, 'owner', by)).toBe('unclear');
    expect((await loadConfirmation(jobId, by))?.state).toBe('pending');
    expect(await phaseOf(jobId)).toBe('plan');
  });
});

describe('scheduler expiry', () => {
  it('expires a stale question and closes its job', async () => {
    const stale = await parkedJob();
    await ask(stale, [OPTION_A, OPTION_B]);
    await presentedAt(stale, new Date(Date.now() - 31 * 60_000));
    const fresh = await parkedJob();
    await ask(fresh, [SINGLE]);

    const result = await schedulerPass({ businessId: BUSINESS, runtime: inertRuntime(), inbox: null });

    expect(result.expiredConfirmations).toEqual([stale]);
    expect(result.settledConfirmations).toEqual({ settled: [{ jobId: stale, to: 'closed' }], errored: [] });
    expect(result.expiredConfirmationsError).toBeNull();
    expect(await phaseOf(stale)).toBe('closed');
    const { rows } = await getPool().query<{ reason: string }>(
      "SELECT reason FROM job_steps WHERE job_id = $1 AND to_phase = 'closed'",
      [stale],
    );
    expect(rows.map((r) => r.reason)).toEqual(['command: confirmation expired']);
    expect((await loadConfirmation(stale, { businessId: BUSINESS }))?.state).toBe('expired');
    expect(await phaseOf(fresh)).toBe('plan');
  });

  it('leaves a job that already left plan alone when its question expires', async () => {
    const gone = await parkedJob();
    await ask(gone, [SINGLE]);
    await presentedAt(gone, new Date(Date.now() - 31 * 60_000));
    await transition(gone, { to: 'closed', actor: 'system', reason: 'other', businessId: BUSINESS });

    const result = await schedulerPass({ businessId: BUSINESS, runtime: inertRuntime(), inbox: null });

    expect(result.expiredConfirmations).toEqual([gone]);
    expect(result.settledConfirmations).toEqual({ settled: [], errored: [] });
    expect(result.expiredConfirmationsError).toBeNull();
    expect(await transitionsTo(gone, 'closed')).toBe(1);
  });
});

describe('settleDecidedConfirmations', () => {
  const by = { businessId: BUSINESS };

  it('cancelled, job still in plan → closed', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [OPTION_A, OPTION_B]);
    expect(await cancelConfirmation(jobId, 'owner', by)).toBe(true);
    expect(await settleDecidedConfirmations(by)).toEqual({ settled: [{ jobId, to: 'closed' }], errored: [] });
    expect(await reasonsTo(jobId, 'closed')).toEqual(['command: cancelled']);
  });

  it('expired, job still in plan (a failed close last pass) → closed', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [SINGLE]);
    expect(await expireConfirmations({ businessId: BUSINESS, windowMinutes: 0 })).toEqual([jobId]);
    expect(await settleDecidedConfirmations(by)).toEqual({ settled: [{ jobId, to: 'closed' }], errored: [] });
    expect(await reasonsTo(jobId, 'closed')).toEqual(['command: confirmation expired']);
  });

  it('confirmed and bound to the chosen plan → execute', async () => {
    const jobId = await parkedJob();
    await bindPlanToJob(jobId, PLAN_A, by);
    await ask(jobId, [SINGLE]);
    expect(await confirmChoice(jobId, HASH_A, 'owner', by)).toBe(true);
    expect(await settleDecidedConfirmations(by)).toEqual({ settled: [{ jobId, to: 'execute' }], errored: [] });
    expect(await reasonsTo(jobId, 'execute')).toEqual(['command: confirmed']);
  });

  it('confirmed, several options, nothing bound → binds the chosen plan, then execute', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [OPTION_A, OPTION_B]);
    expect(await confirmChoice(jobId, HASH_B, 'owner', by)).toBe(true);
    expect(await settleDecidedConfirmations(by)).toEqual({ settled: [{ jobId, to: 'execute' }], errored: [] });
    expect((await loadStoredPlan(jobId, by))?.planHash).toBe(HASH_B);
  });

  it('confirmed but bound to another plan → failed', async () => {
    const jobId = await parkedJob();
    await bindPlanToJob(jobId, PLAN_C, by);
    await ask(jobId, [SINGLE]);
    expect(await confirmChoice(jobId, HASH_A, 'owner', by)).toBe(true);
    expect(await settleDecidedConfirmations(by)).toEqual({ settled: [{ jobId, to: 'failed' }], errored: [] });
    expect(await reasonsTo(jobId, 'failed')).toEqual([UNAPPLIABLE_REASON]);
    expect(await transitionsTo(jobId, 'execute')).toBe(0);
  });

  it('confirmed, single option, nothing bound → failed', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [SINGLE]);
    expect(await confirmChoice(jobId, HASH_A, 'owner', by)).toBe(true);
    expect(await settleDecidedConfirmations(by)).toEqual({ settled: [{ jobId, to: 'failed' }], errored: [] });
  });

  it('confirmed, several options, a bind that refuses → failed', async () => {
    const jobId = await parkedJob();
    await ask(jobId, [OPTION_A, OPTION_B]);
    await tamperFirstOption(jobId);
    expect(await confirmChoice(jobId, HASH_A, 'owner', by)).toBe(true);
    expect(await settleDecidedConfirmations(by)).toEqual({ settled: [{ jobId, to: 'failed' }], errored: [] });
    expect(await loadStoredPlan(jobId, by)).toBeNull();
  });

  it('an applyConfirmation that threw after its flip is finished by the sweep', async () => {
    const jobId = await parkedJob();
    await bindPlanToJob(jobId, PLAN_C, by);
    await ask(jobId, [SINGLE]);
    await expect(applyConfirmation(jobId, { kind: 'confirm', planHash: HASH_A }, 'owner', by)).rejects.toThrow();
    expect(await phaseOf(jobId)).toBe('plan');
    await settleDecidedConfirmations(by);
    expect(await phaseOf(jobId)).toBe('failed');
  });

  it('ignores pending rows and jobs without an instruction row', async () => {
    const pending = await parkedJob();
    await ask(pending, [SINGLE]);
    const orphan = (
      await createJob({ charterVersion: await charterVersion(BUSINESS), provenance: 'boss', businessId: BUSINESS })
    ).jobId;
    await transition(orphan, { to: 'understand', actor: 'orchestrator', reason: 't', businessId: BUSINESS });
    await transition(orphan, { to: 'plan', actor: 'orchestrator', reason: 't', businessId: BUSINESS });
    await ask(orphan, [SINGLE]);
    await cancelConfirmation(orphan, 'owner', by);
    expect(await settleDecidedConfirmations(by)).toEqual({ settled: [], errored: [] });
    expect(await phaseOf(orphan)).toBe('plan');
    expect(await phaseOf(pending)).toBe('plan');
  });

  it("one job's failure does not stop another's", async () => {
    const broken = await parkedJob();
    await ask(broken, [SINGLE]);
    await cancelConfirmation(broken, 'owner', by);
    const fine = await parkedJob();
    await ask(fine, [SINGLE]);
    await cancelConfirmation(fine, 'owner', by);

    await getPool().query(`
      CREATE FUNCTION test_refuse_job_step() RETURNS trigger AS $$
      BEGIN
        IF NEW.job_id = '${broken}' THEN RAISE EXCEPTION 'refused for test'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await getPool().query(
      'CREATE TRIGGER test_refuse_job_step BEFORE INSERT ON job_steps FOR EACH ROW EXECUTE FUNCTION test_refuse_job_step()',
    );
    try {
      const result = await settleDecidedConfirmations(by);
      expect(result.settled).toEqual([{ jobId: fine, to: 'closed' }]);
      expect(result.errored.map((e) => e.jobId)).toEqual([broken]);
      expect(result.errored[0]?.error).toContain('refused for test');
    } finally {
      await getPool().query('DROP TRIGGER test_refuse_job_step ON job_steps');
      await getPool().query('DROP FUNCTION test_refuse_job_step()');
    }
    expect(await phaseOf(fine)).toBe('closed');
    expect(await phaseOf(broken)).toBe('plan');
  });
});
