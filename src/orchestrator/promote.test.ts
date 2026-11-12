/**
 * The evaluation pass: who climbs and who comes back down.
 *
 * Two rules shape every test in this file, both of them scars.
 *
 * **A "nothing moved" assertion never stands on the return value alone.**
 * `expect(result.promoted).toEqual([])` holds just as well when the pass
 * crashed, returned early, or never reached the class at all — the failure
 * this project has documented three times (spec §12.10). Every such test here
 * reads the `autonomy_ramp` row itself, and most also carry a positive control
 * in the same call: a second class on identical evidence that DOES move, or
 * the same data re-evaluated with one input changed. If the control does not
 * move either, the pass did not run and the test fails.
 *
 * **`loadRampLevel` is not the row.** The dial clamps what it returns, so at
 * `off` it answers `draft_only` and at `ask` it answers `approve_required`
 * whatever is stored. A test that only read it could not tell a pass that
 * wrote nothing from a pass that wrote `auto_notify` underneath the clamp.
 * `storedLevel` reads the column directly, and that is the assertion that
 * carries the weight in the two dial tests.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool, withBusiness, type BusinessDb } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { decide, enqueueApproval } from '../governance/approvals.js';
import { saveInstruction } from '../governance/instructions.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import { MIN_SAMPLES } from '../governance/agreement.js';
import { assessRisk } from '../policy/risk.js';
import { canonicalHash } from '../util/canonical.js';
import { Plan } from '../domain/plan.js';
import { createJob, transition } from './jobs.js';
import { bindPlanToJob } from './plan-store.js';
import { loadRampLevel, setRampLevel } from './ramp.js';
import { schedulerPass } from './scheduler.js';
import { evaluateAutonomy } from './promote.js';
import { AdapterRegistry } from './adapters/registry.js';
import { envCredentials } from './credentials.js';
import type { Runtime } from './runtime.js';

import type { ActionClass } from '../domain/action.js';
import type { PolicyBundle, ActionFacts } from '../domain/policy.js';

const BUSINESS = 'test-business';

let bundle: PolicyBundle;
/** Bumped on every seeded row so each gets a distinct, strictly-increasing `decided_at`. */
let sequence = 0;

/**
 * Where seeded decisions sit on the clock.
 *
 * `PAST` is an hour ago, so cards seeded with it are older than any
 * `autonomy_events` row this file writes through `evaluateAutonomy` (those
 * carry SQL `now()`). `FUTURE` is an hour ahead, for the one test that needs
 * decisions made AFTER a demotion. Which side of the last ramp event a card
 * falls on is load-bearing — it is the whole of "the window starts again" —
 * so it is chosen per card rather than left to wall-clock luck.
 */
const PAST = Date.now() - 60 * 60 * 1000;
const FUTURE = Date.now() + 60 * 60 * 1000;

/**
 * Real `ActionFacts`, never `as never` — the shape `agreement.test.ts` seeds
 * with, which is the fixture this file deliberately copies rather than
 * inventing a second one. `toolName` stays `mail.send` because nothing here
 * reads it; the `action_class` column is what the measurement joins on.
 */
function factsFor(actionClass: ActionClass, input: unknown): ActionFacts {
  return {
    toolName: 'mail.send',
    actionClass,
    provenance: 'boss',
    chainDepth: 0,
    provenanceChainDerived: false,
    inputHash: canonicalHash(input),
    amountMinor: 0,
    amountDeclared: false,
    counterpartyId: null,
    counterpartyEmails: ['dana@example.com'],
    counterpartyPhones: [],
    counterpartyTags: [],
    dataClasses: [],
    leavesInstance: true,
    supplierId: null,
    discountPercent: 0,
  };
}

/**
 * Seed one decided card on a mailbox reply job.
 *
 * Only cards on a job that a `mail_messages` row names as its `reply_job_id`
 * are evidence for the agreement rate (spec §5.1), so every card here gets its
 * own job and its own linked mail. `denied` is a wrong verdict; `approved` an
 * unedited agreement.
 */
async function card(
  actionClass: ActionClass,
  outcome: 'approved' | 'denied',
  opts: { epoch?: number } = {},
): Promise<void> {
  sequence += 1;
  const jobId = `J-promote-${sequence}`;
  await testDb().query(
    `INSERT INTO mail_messages
       (mail_id, business_id, provider_message_id, thread_id, from_address, subject,
        received_at, body_text, state, reply_job_id)
     VALUES ($1, $2, $3, $4, 'dana@example.com', 's', now(), 'b', 'triaged', $5)`,
    [`M-promote-${sequence}`, BUSINESS, `pm-${sequence}`, `th-${sequence}`, jobId],
  );
  const input = { to: 'dana@example.com', body: `card-${sequence}` };
  const facts = factsFor(actionClass, input);
  const risk = await assessRisk(facts, bundle);
  const approvalId = await withBusiness(BUSINESS, (bdb) => enqueueApproval(
    bdb,
    { facts, risk, proposedInput: input, summary: 'שליחת מייל', jobId }
  ));
  await withBusiness(BUSINESS, (bdb) => decide(
    bdb,
    approvalId,
    outcome,
    { by: 'p_boss', channel: 'dashboard' }
  ));

  // `decide` stamps `decided_at` with SQL now(); overwriting with a value that
  // strictly increases with `sequence` keeps the order unambiguous, and choosing
  // the epoch places the card before or after the ramp events this file writes.
  await testDb().query(`UPDATE approval_requests SET decided_at = $1 WHERE approval_id = $2`, [
    new Date((opts.epoch ?? PAST) + sequence * 1_000).toISOString(),
    approvalId,
  ]);
}

/** A clean run of `n` unedited approvals for one class. */
async function cleanRun(
  actionClass: ActionClass,
  n: number,
  opts: { epoch?: number } = {},
): Promise<void> {
  for (let i = 0; i < n; i += 1) await card(actionClass, 'approved', opts);
}

/** `right` approvals followed by `wrong` denials: an exact agreement rate. */
async function verdicts(actionClass: ActionClass, right: number, wrong: number): Promise<void> {
  await cleanRun(actionClass, right);
  for (let i = 0; i < wrong; i += 1) await card(actionClass, 'denied');
}

/**
 * The stored level, read from the column rather than through `loadRampLevel`.
 *
 * `undefined` means no row at all, which is a different fact from a row
 * holding the floor — see this file's header.
 */
async function storedLevel(actionClass: ActionClass): Promise<string | undefined> {
  const { rows } = await getPool().query<{ level: string }>(
    'SELECT level FROM autonomy_ramp WHERE business_id = $1 AND action_class = $2',
    [BUSINESS, actionClass],
  );
  return rows[0]?.level;
}

async function events(
  actionClass: ActionClass,
): Promise<{ direction: string; from_level: string; to_level: string }[]> {
  const { rows } = await getPool().query<{
    direction: string;
    from_level: string;
    to_level: string;
  }>(
    `SELECT direction, from_level, to_level FROM autonomy_events
      WHERE business_id = $1 AND action_class = $2 ORDER BY at ASC, event_id ASC`,
    [BUSINESS, actionClass],
  );
  return rows;
}

/** The `reason` on the newest event for a class — what spec §8 shows the owner. */
async function newestReason(actionClass: ActionClass): Promise<string | undefined> {
  const { rows } = await getPool().query<{ reason: string }>(
    `SELECT reason FROM autonomy_events
      WHERE business_id = $1 AND action_class = $2
      ORDER BY at DESC, event_id DESC LIMIT 1`,
    [BUSINESS, actionClass],
  );
  return rows[0]?.reason;
}

/** A plan whose only step declares `actionClass` — what a failure is attributed by. */
function planDeclaring(actionClass: ActionClass): Plan {
  return Plan.parse({
    goal: 'לענות ללקוח',
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'reply_to_sender',
        toolName: 'mail.send',
        input: { to: 'dana@example.com', body: 'שלום', inReplyTo: 'M-1' },
        expectedActionClass: actionClass,
      },
    ],
  });
}

/** A job that reached `failed`, carrying a bound plan that declares `actionClass`. */
async function failedJobDeclaring(actionClass: ActionClass): Promise<string> {
  const job = await withBusiness(BUSINESS, (db) => createJob(db, {
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
  }));
  await withBusiness(BUSINESS, (db) => bindPlanToJob(db, job.jobId, planDeclaring(actionClass)));
  await withBusiness(BUSINESS, (db) => transition(db, job.jobId, {
    to: 'failed',
    actor: 'orchestrator',
    reason: 'channel_unavailable',
  }));
  return job.jobId;
}

describe('the evaluation pass', () => {
  beforeEach(async () => {
    await resetDatabase();
    sequence = 0;
    bundle = await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()));
  });
  afterAll(async () => {
    await closePool();
  });

  /**
   * Spec §12.2. The positive control is the second half: the same seeded
   * history, evaluated again with nothing changed but the dial, does promote —
   * so the first evaluation demonstrably ran and the dial is what held it.
   */
  it('does not move anything while the dial is off, however clean the record', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'off', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    await cleanRun('email.reply', MIN_SAMPLES + 5);

    const result = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(result.promoted).toEqual([]);
    // The assertions that matter: the row itself did not move, and no event
    // was recorded. `loadRampLevel` alone could not tell — the dial clamps it
    // to `draft_only` whatever is stored.
    expect(await storedLevel('email.reply')).toBe('approve_required');
    expect(await events('email.reply')).toEqual([]);
    expect(await withBusiness(BUSINESS, (db) => loadRampLevel(db, 'email.reply'))).toBe('draft_only');

    // Positive control: only the dial changes.
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toContain('email.reply');
  });

  /** Spec §3: `ask` measures, it does not climb. Same positive control. */
  it('does not promote on the dial at ask — measuring is not climbing', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'ask', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    await cleanRun('email.reply', MIN_SAMPLES);

    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toEqual([]);
    expect(await storedLevel('email.reply')).toBe('approve_required');
    expect(await events('email.reply')).toEqual([]);
    expect(await withBusiness(BUSINESS, (db) => loadRampLevel(db, 'email.reply'))).toBe('approve_required');

    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toContain('email.reply');
    expect(await storedLevel('email.reply')).toBe('auto_notify');
  });

  /** Spec §5.1. The one earned rung in the system. */
  it('promotes one step at learn once the owner agreed enough', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    await cleanRun('email.reply', MIN_SAMPLES);

    const result = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(result.promoted).toContain('email.reply');
    expect(result.demoted).toEqual([]);
    expect(await withBusiness(BUSINESS, (db) => loadRampLevel(db, 'email.reply'))).toBe('auto_notify');
    expect(await storedLevel('email.reply')).toBe('auto_notify');
  });

  /**
   * The rule: strictly more than 80% of at least five owner verdicts. Each
   * negative case re-evaluates the SAME class after one more verdict tips it
   * over, so the first evaluation demonstrably ran and declined (a positive
   * control per case, not a return-value-only assertion).
   */
  it('does not promote on four verdicts, however clean — and does on the fifth', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    await cleanRun('email.reply', MIN_SAMPLES - 1);

    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toEqual([]);
    expect(await storedLevel('email.reply')).toBe('approve_required');
    expect(await events('email.reply')).toEqual([]);

    await cleanRun('email.reply', 1);
    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toEqual(['email.reply']);
  });

  it('does not promote on 4 of 5 (80%)', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    await verdicts('email.reply', 4, 1);

    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toEqual([]);
    expect(await storedLevel('email.reply')).toBe('approve_required');
    expect(await events('email.reply')).toEqual([]);

    // Control: one more agreement makes it 5 of 6, which clears 80%.
    await cleanRun('email.reply', 1);
    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toEqual(['email.reply']);
  });

  it('exactly 80% does not promote (8 of 10) — the threshold is strict', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    await verdicts('email.reply', 8, 2);

    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toEqual([]);
    expect(await storedLevel('email.reply')).toBe('approve_required');

    // Control: 9 of 11 is 81.8%.
    await cleanRun('email.reply', 1);
    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toEqual(['email.reply']);
  });

  it('promotes on 5 of 6, and the event row says how many and what percent', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    await verdicts('email.reply', 5, 1);

    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toEqual(['email.reply']);
    expect(await newestReason('email.reply')).toBe('5 מתוך 6 הכרעות אחרונות (83%)');
  });

  /**
   * Spec §9.1 — the event table is what keeps the demotion count derived, so
   * one move must write exactly one row. The second evaluation is the other
   * half: a class already at `auto_notify` must not keep writing rows every
   * pass, which would make "has this fallen twice" count promotions too.
   */
  it('writes one event row per move, which is what the demotion count reads', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    await cleanRun('email.reply', MIN_SAMPLES);

    await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(await events('email.reply')).toEqual([
      { direction: 'promote', from_level: 'approve_required', to_level: 'auto_notify' },
    ]);

    const again = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(again.promoted).toEqual([]);
    expect(await events('email.reply')).toHaveLength(1);
  });

  /**
   * Finding 6, final review: `from_level` must name what the row actually
   * held, not the level the dial's ceiling made visible to this pass.
   * `learn`'s ceiling is `auto_notify`, so a class hand-raised to `auto`
   * (above it) is clamped down to `auto_notify` for every read `evaluateAutonomy`
   * makes — but the event demoting it off that class must still say `auto`,
   * because that is the level the class was actually stored at.
   */
  it('logs the row it actually held as from_level, not the level the dial clamped to', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'auto'));
    // The clamp is doing real work here: the gate never sees 'auto' under
    // `learn`, only the ceiling.
    expect(await withBusiness(BUSINESS, (db) => loadRampLevel(db, 'email.reply'))).toBe('auto_notify');

    await testDb().query(
      `INSERT INTO autonomy_marks (mark_id, business_id, job_id, step_id, action_class, note, marked_by)
       VALUES ('AM-test-raw-from', $1, 'J-test', 'S-test', 'email.reply', 'טעות', 'owner@example.com')`,
      [BUSINESS],
    );

    const result = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(result.demoted).toContain('email.reply');
    expect(await events('email.reply')).toEqual([
      { direction: 'demote', from_level: 'auto', to_level: 'approve_required' },
    ]);
  });

  /**
   * Spec §6.1, §6.3, §12.5. Two claims, and the second is the one an earlier
   * draft of this pass got wrong: after a demotion the class must earn five
   * NEW clean approvals, not inherit the five it already had. The final third
   * of the test is the positive control — five fresh approvals decided after
   * the demotion do promote it again, so the middle assertion is the reset
   * biting and not the machinery being dead.
   */
  it('demotes on an owner mark, and the window starts again', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    await cleanRun('email.reply', MIN_SAMPLES);
    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toContain('email.reply');

    await testDb().query(
      `INSERT INTO autonomy_marks
         (mark_id, business_id, job_id, step_id, action_class, note, marked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      ['MK-1', BUSINESS, 'J-x', 's1', 'email.reply', 'זו הייתה טעות', 'p_boss'],
    );

    const fall = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(fall.demoted).toContain('email.reply');
    expect(await withBusiness(BUSINESS, (db) => loadRampLevel(db, 'email.reply'))).toBe('approve_required');
    expect(await storedLevel('email.reply')).toBe('approve_required');

    // The window starts again: the five approvals that earned the first
    // promotion were all decided before the demotion and must not earn a
    // second one.
    const stale = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(stale.promoted).toEqual([]);
    expect(await storedLevel('email.reply')).toBe('approve_required');
    expect(await events('email.reply')).toHaveLength(2);

    // Positive control: five decided after the demotion do earn it.
    await cleanRun('email.reply', MIN_SAMPLES, { epoch: FUTURE });
    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toContain('email.reply');
    expect(await storedLevel('email.reply')).toBe('auto_notify');
  });

  /**
   * Spec §6.1, §6.1.1, §12.6 — the net under the owner's attention. Nobody
   * marked anything; a job simply ended in `failed` carrying a plan that
   * declares the class.
   */
  it('demotes on a failed job with no human involved at all', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    await cleanRun('email.reply', MIN_SAMPLES);
    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toContain('email.reply');

    await failedJobDeclaring('email.reply');

    const fall = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(fall.demoted).toContain('email.reply');
    expect(await withBusiness(BUSINESS, (db) => loadRampLevel(db, 'email.reply'))).toBe('approve_required');
    expect(await storedLevel('email.reply')).toBe('approve_required');
    // No human touched it: the demotion came from the job record alone.
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM autonomy_marks WHERE business_id = $1',
      [BUSINESS],
    );
    expect(rows[0]?.n).toBe('0');
  });

  /**
   * Owner rule B4: a boss command is not measured in shadow mode. The pair is
   * the proof — the same failed job, with and without a `boss_instructions`
   * row, and only the one without demotes.
   */
  it('a failed boss command does not demote; the same failure without an instruction does', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    await cleanRun('email.reply', MIN_SAMPLES);
    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toContain('email.reply');

    const command = await failedJobDeclaring('email.reply');
    await withBusiness(BUSINESS, (bdb) => saveInstruction(bdb, { jobId: command, text: 'תעני לדנה', textOrigin: 'typed' }));

    const held = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(held.demoted).toEqual([]);
    expect(await storedLevel('email.reply')).toBe('auto_notify');

    await failedJobDeclaring('email.reply');
    const fall = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(fall.demoted).toContain('email.reply');
    expect(await storedLevel('email.reply')).toBe('approve_required');
  });

  it('a mark on a boss-command step does not demote; the same mark on another job does', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    await cleanRun('email.reply', MIN_SAMPLES);
    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toContain('email.reply');

    const command = await withBusiness(BUSINESS, (db) => createJob(db, { charterVersion: bundle.charterVersion, provenance: 'boss' }));
    await withBusiness(BUSINESS, (bdb) => saveInstruction(bdb, { jobId: command.jobId, text: 'תעני לדנה', textOrigin: 'typed' }));
    const mark = async (markId: string, jobId: string): Promise<void> => {
      await testDb().query(
        `INSERT INTO autonomy_marks
           (mark_id, business_id, job_id, step_id, action_class, note, marked_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [markId, BUSINESS, jobId, 's1', 'email.reply', 'זו הייתה טעות', 'p_boss'],
      );
    };
    await mark('MK-cmd', command.jobId);

    const held = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(held.demoted).toEqual([]);
    expect(await storedLevel('email.reply')).toBe('auto_notify');

    await mark('MK-other', 'J-other');
    const fall = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(fall.demoted).toContain('email.reply');
    expect(await storedLevel('email.reply')).toBe('approve_required');
  });

  /**
   * Spec §6.4, §12.9. The two demotions are seeded BEFORE the approvals on
   * the clock, so the reset rule is satisfied and the only thing left holding
   * the class down is the fall count. Removing one of the two falls and
   * re-evaluating the same evidence is the positive control.
   */
  it('stops climbing after two demotions, even on a perfect record', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    const before = new Date(PAST - 60_000).toISOString();
    for (const id of ['AE-1', 'AE-2']) {
      await testDb().query(
        `INSERT INTO autonomy_events
           (event_id, business_id, action_class, direction, from_level, to_level, reason, at)
         VALUES ($1,$2,'email.reply','demote','auto_notify','approve_required','טעות',$3)`,
        [id, BUSINESS, before],
      );
    }
    await cleanRun('email.reply', MIN_SAMPLES);

    const result = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(result.promoted).toEqual([]);
    expect(await storedLevel('email.reply')).toBe('approve_required');
    expect(await events('email.reply')).toHaveLength(2);

    // Control: with only one demotion on record the same evidence promotes, so
    // the fall count is what held it and the evidence was sufficient.
    await testDb().query(`DELETE FROM autonomy_events WHERE event_id = 'AE-2'`);
    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toEqual(['email.reply']);
  });

  /**
   * Spec §5.4 — `auto_notify → auto` is not built, and the measurement must
   * never reach for it. Lowering the class one rung and re-evaluating is the
   * positive control.
   */
  it('never promotes above auto_notify', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'auto_notify'));
    await cleanRun('email.reply', MIN_SAMPLES);

    const result = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(result.promoted).toEqual([]);
    expect(result.demoted).toEqual([]);
    expect(await storedLevel('email.reply')).toBe('auto_notify');
    expect(await withBusiness(BUSINESS, (db) => loadRampLevel(db, 'email.reply'))).toBe('auto_notify');
    expect(await events('email.reply')).toEqual([]);

    // Control: the same evidence does move a class that sits one rung lower.
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).promoted).toEqual(['email.reply']);
  });

  /**
   * Spec §10 — the pass has a production caller.
   *
   * `evaluateAutonomy` being right is worth nothing if `schedulerPass` does
   * not call it, and this repository records the "function with no production
   * caller" defect four separate times. Replacing the call with a literal
   * left all three scheduler test files green; this is the test that goes red
   * for it. The companion in `scheduler-runs-plans.test.ts` locks the other
   * half — that it runs LAST — with evidence that pass itself produces.
   */
  it('is wired into schedulerPass, not merely exported', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    await cleanRun('email.reply', MIN_SAMPLES);

    // `inbox: null` keeps both document-conductor loops off: this test is
    // about the autonomy pass, and the conductor's half costs money.
    // `buildRuntime` now reads the installation's master key file and
    // refuses to build without one, so the lazy default would throw here.
    // This pass is about the autonomy evaluation and touches no adapter and
    // no credential, so it is handed an inert runtime rather than a key.
    const inert: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, 'TEST_CRED_'),
      warnings: [],
    };
    const pass = await schedulerPass({ businessId: BUSINESS, inbox: null, runtime: inert });

    expect(pass.autonomy.promoted).toContain('email.reply');
    expect(pass.autonomy.errored).toEqual([]);
    expect(pass.autonomyError).toBeNull();
    expect(await storedLevel('email.reply')).toBe('auto_notify');
  });

  /**
   * Spec §9.1 — the event row is the history the owner's screen reads, so it
   * has to say WHICH signal fired. A fixed disjunction ("a mark or a failed
   * job") answers neither half of "why was this class demoted on Tuesday".
   */
  it('records which signal demoted the class, not a disjunction of both', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'auto_notify'));
    await failedJobDeclaring('email.reply');

    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).demoted).toContain('email.reply');
    const reason = await newestReason('email.reply');
    expect(reason).toContain('משימה שנכשלה');
    expect(reason).not.toContain('סימון');
  });

  /**
   * Spec §6.1 — a failure counts only under a level ABOVE `approve_required`.
   *
   * The owner raises a class by hand (`npm run ramp:set`, the path CLAUDE.md
   * documents as in use on `dev-business`). With no window, `failureCount`
   * reached over all history and the very next pass demoted it on a job that
   * failed BEFORE the raise — the documented raise quietly undoing itself.
   * The second half is the positive control: a failure after the raise does
   * demote, so the window is what moved and not the signal.
   */
  it('ignores a failure that predates a hand-raised level, and heeds one after it', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await failedJobDeclaring('email.reply');
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'auto_notify'));

    const first = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(first.demoted).toEqual([]);
    expect(await storedLevel('email.reply')).toBe('auto_notify');
    expect(await events('email.reply')).toEqual([]);

    await failedJobDeclaring('email.reply');
    expect((await withBusiness(BUSINESS, (db) => evaluateAutonomy(db))).demoted).toContain('email.reply');
    expect(await storedLevel('email.reply')).toBe('approve_required');
  });

  /**
   * The level, the event row and the audit entry are one fact and commit
   * together.
   *
   * Written as four statements on the pool, a failure in the last of them left
   * the class ALREADY at `auto_notify` with no audit row and nothing in
   * `promoted` — autonomy raised, silently. `appendAudit` takes a per-business
   * advisory lock and so fails exactly when the system is busy, which is the
   * scenario `killswitch.ts` documents.
   *
   * The failure is injected with a trigger that refuses this audit kind, and
   * removed in `finally`. The removal cannot itself throw — `DROP TRIGGER IF
   * EXISTS` on a trigger this test created — which is the lesson Task 1 paid
   * for: a cleanup that can fail is not a cleanup.
   */
  it('rolls the level back when the audit entry cannot be written', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await withBusiness(BUSINESS, (db) => setRampLevel(db, 'email.reply', 'approve_required'));
    await cleanRun('email.reply', MIN_SAMPLES);

    await testDb().query(`
      CREATE OR REPLACE FUNCTION refuse_autonomy_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.kind = 'autonomy_change' THEN
          RAISE EXCEPTION 'audit refused by test';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    try {
      await testDb().query(`
        CREATE TRIGGER refuse_autonomy_audit_trigger
        BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION refuse_autonomy_audit()
      `);

      const blocked = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
      expect(blocked.promoted).toEqual([]);
      // Nothing half-happened: the level is untouched and no event row exists.
      expect(await storedLevel('email.reply')).toBe('approve_required');
      expect(await events('email.reply')).toEqual([]);
      // And it is reported rather than swallowed.
      expect(blocked.errored).toContain('email.reply');
    } finally {
      await testDb().query('DROP TRIGGER IF EXISTS refuse_autonomy_audit_trigger ON audit_log');
      await testDb().query('DROP FUNCTION IF EXISTS refuse_autonomy_audit()');
    }

    // Positive control: with the obstacle gone, the same evidence promotes.
    const after = await withBusiness(BUSINESS, (db) => evaluateAutonomy(db));
    expect(after.promoted).toContain('email.reply');
    expect(after.errored).toEqual([]);
    expect(await storedLevel('email.reply')).toBe('auto_notify');
  });

  /**
   * Spec §10 — one class failing must not stop the rest, and must not look
   * like nothing being due either.
   */
  it('isolates a class whose evaluation throws, and names it in errored', async () => {
    await withBusiness(BUSINESS, (bdb) => setAutonomyMode(bdb, 'learn', 'owner@example.com'));
    await cleanRun('email.reply', MIN_SAMPLES);
    await cleanRun('email.initiate', MIN_SAMPLES);

    // A connection that refuses every statement carrying this one class. The
    // cast is for `pg`'s overloaded `query` signature only — the body does no
    // narrowing of its own.
    const result = await withBusiness(BUSINESS, (db) => {
      const refusing: BusinessDb = {
        businessId: db.businessId,
        inTransaction: db.inTransaction,
        query: ((text: string, params?: unknown[]) => {
          if (Array.isArray(params) && params.includes('email.reply')) {
            return Promise.reject(new Error('injected read failure'));
          }
          return db.query(text, params as unknown[]);
        }) as BusinessDb['query'],
      };
      return evaluateAutonomy(refusing);
    });
    expect(result.errored).toEqual(['email.reply']);
    expect(result.promoted).toEqual(['email.initiate']);
    expect(await storedLevel('email.reply')).toBeUndefined();
  });
});
