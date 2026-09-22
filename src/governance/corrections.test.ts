import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import { createJob } from '../orchestrator/jobs.js';
import { bindPlanToJob } from '../orchestrator/plan-store.js';
import { recallMemories } from '../memory/store.js';
import { recordCorrection } from './corrections.js';

const BUSINESS = 'test-business';

/** One step sending to `dana@example.com`, classified `email.reply`. */
function planTo(recipient: string): Plan {
  return Plan.parse({
    goal: 'reply to a customer',
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'reply to the customer',
        toolName: 'mail.send',
        input: { to: recipient, body: 'שלום' },
        expectedActionClass: 'email.reply',
      },
    ],
  });
}

/** A step whose payload names no recipient at all — `calendar.create` still
 * addresses a `person` (per `messagesAPerson`), but this input carries
 * neither `to`, `recipient`, `email`, `phone`, `toNumber` nor `msisdn`. */
const PLAN_WITH_NO_RECIPIENT: Plan = Plan.parse({
  goal: 'book a slot',
  steps: [
    {
      id: 's1',
      agent: 'sched.meetings',
      intent: 'book a meeting',
      toolName: 'calendar.create',
      input: { title: 'סיור באתר', when: '2026-10-01T09:00:00.000Z' },
      expectedActionClass: 'calendar.create',
    },
  ],
});

/** Installs the charter once per test; `resetDatabase` clears it between tests. */
async function ensureCharter(): Promise<string> {
  const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
  return bundle.charterVersion;
}

async function seedJob(
  charterVersion: string,
  provenance: 'boss' | 'unknown_external',
  plan: Plan,
): Promise<string> {
  const job = await createJob({
    charterVersion,
    provenance,
    businessId: BUSINESS,
    title: 'corrections test job',
  });
  await bindPlanToJob(job.jobId, plan, { businessId: BUSINESS });
  return job.jobId;
}

describe('recordCorrection', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  /**
   * Spec §7.4, and the dangerous point of the whole feature. `writeMemory`
   * reads provenance from the JOB, deliberately — a caller that can declare
   * its own trust level can launder a stranger's claim into the owner's
   * knowledge. A correction to a card that was born of an external document
   * would therefore be stamped `unknown_external` and lose its standing.
   *
   * The fix is not a new field: the correction opens its own job with `boss`
   * as a literal, exactly as the instruction door does. This asserts
   * BEHAVIOUR — the stored row's provenance — and not a type.
   */
  it('stamps the correction with the owner, even on a job born of a stranger', async () => {
    const charterVersion = await ensureCharter();
    const strangerJob = await seedJob(charterVersion, 'unknown_external', planTo('dana@example.com'));

    await recordCorrection(
      {
        jobId: strangerJob,
        stepId: 's1',
        actionClass: 'email.reply',
        note: 'הנוסח היה רשמי מדי',
        by: 'owner@example.com',
      },
      { businessId: BUSINESS },
    );

    const rows = await recallMemories({ subjectKey: 'dana@example.com' }, { businessId: BUSINESS });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provenance).toBe('boss');
  });

  it('records the mark so the next pass can demote on it', async () => {
    const charterVersion = await ensureCharter();
    const jobId = await seedJob(charterVersion, 'boss', planTo('dana@example.com'));

    const result = await recordCorrection(
      {
        jobId,
        stepId: 's1',
        actionClass: 'email.reply',
        note: 'הנוסח היה רשמי מדי',
        by: 'owner@example.com',
      },
      { businessId: BUSINESS },
    );

    const { rows } = await getPool().query<{
      job_id: string;
      step_id: string;
      action_class: string;
      note: string;
      marked_by: string;
    }>(
      `SELECT job_id, step_id, action_class, note, marked_by
         FROM autonomy_marks WHERE business_id = $1 AND mark_id = $2`,
      [BUSINESS, result.markId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      job_id: jobId,
      step_id: 's1',
      action_class: 'email.reply',
      note: 'הנוסח היה רשמי מדי',
      marked_by: 'owner@example.com',
    });
  });

  /**
   * Spec §7.3 — the planner's memory block has a hard character budget and
   * fills in subject order, so corrections that accumulate would push real
   * facts about other people out of the prompt entirely. Replace-on-write is
   * what stops learning from damaging memory. `recallMemories` already
   * filters `retired_at IS NULL` in its own WHERE — `MemoryRecord` carries no
   * `retiredAt` field, so filtering here would not compile — so what comes
   * back IS the live set, and it must hold only the newer correction.
   */
  it('supersedes an earlier correction on the same person and action class', async () => {
    const charterVersion = await ensureCharter();
    const firstJob = await seedJob(charterVersion, 'boss', planTo('dana@example.com'));
    await recordCorrection(
      { jobId: firstJob, stepId: 's1', actionClass: 'email.reply', note: 'הראשון', by: 'owner@example.com' },
      { businessId: BUSINESS },
    );

    const secondJob = await seedJob(charterVersion, 'boss', planTo('dana@example.com'));
    await recordCorrection(
      { jobId: secondJob, stepId: 's1', actionClass: 'email.reply', note: 'השני', by: 'owner@example.com' },
      { businessId: BUSINESS },
    );

    const live = await recallMemories({ subjectKey: 'dana@example.com' }, { businessId: BUSINESS });
    expect(live).toHaveLength(1);
    expect(JSON.stringify(live[0]?.body)).toContain('השני');
  });

  /**
   * A positive rule: a memory is written only when a recipient can actually
   * be resolved from the step. Inventing a subject key for an action with no
   * addressee would file the lesson where nothing will ever recall it.
   */
  it('still demotes but remembers nothing when the step names no recipient', async () => {
    const charterVersion = await ensureCharter();
    const jobId = await seedJob(charterVersion, 'boss', PLAN_WITH_NO_RECIPIENT);

    const result = await recordCorrection(
      {
        jobId,
        stepId: 's1',
        actionClass: 'calendar.create',
        note: 'התאריך היה שגוי',
        by: 'owner@example.com',
      },
      { businessId: BUSINESS },
    );

    expect(result.remembered).toBe(false);

    const { rows } = await getPool().query(
      'SELECT 1 FROM autonomy_marks WHERE business_id = $1 AND mark_id = $2',
      [BUSINESS, result.markId],
    );
    expect(rows).toHaveLength(1);
  });
});
