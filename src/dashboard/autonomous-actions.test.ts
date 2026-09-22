/**
 * `listAutonomousActions` — what the mark screen shows, and the one thing it
 * must never show.
 *
 * The load-bearing test in this file is the negative one: a step that went
 * out because the owner clicked "approve" on a card must not appear here,
 * because appearing here means "mark this as a mistake the assistant made on
 * its own" — and an approved card is a decision the owner made, not the
 * assistant. Both jobs below run through the real gate and the real
 * scheduler (`runDueJobs`), not hand-built rows, so the assertion is about
 * behaviour the system actually produces rather than a shape a test invented.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { PolicyBundle } from '../domain/policy.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import { applyDecision } from '../orchestrator/resume.js';
import { pendingApprovals } from '../governance/approvals.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection } from '../domain/connection.js';
import { AdapterRegistry } from '../orchestrator/adapters/registry.js';
import { createMailAdapter, type MailMessage } from '../orchestrator/adapters/mail.js';
import { upsertBinding } from '../orchestrator/bindings.js';
import { envCredentials } from '../orchestrator/credentials.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { bindPlanToJob } from '../orchestrator/plan-store.js';
import { setRampLevel } from '../orchestrator/ramp.js';
import { runDueJobs } from '../orchestrator/run-due.js';
import type { Runtime } from '../orchestrator/runtime.js';
import { listAutonomousActions } from './autonomous-actions.js';

const BUSINESS = 'test-business';
const PREFIX = 'TEST_CRED_';
// Outside the fixture's quiet hours — the same clock `ramp-raise.test.ts` and
// `approved-step.test.ts` fix, and for the same reason: an evening test run
// must not defer a step for a reason unrelated to what is under test.
const NOON = new Date('2026-08-18T09:00:00.000Z');

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

function replyPlan(to: string, subject: string): Plan {
  return Plan.parse({
    goal: 'reply to a known customer',
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'reply to the customer',
        toolName: 'mail.send',
        input: { to, inReplyTo: 'thread-9', subject, body: 'גוף ההודעה' },
        expectedActionClass: 'email.reply',
      },
    ],
  });
}

function runtimeWith(sent: MailMessage[]): Runtime {
  return {
    registry: new AdapterRegistry([
      createMailAdapter({
        system: 'office-mail',
        transport: {
          async send(message) {
            sent.push(message);
            return { messageId: `MSG-${sent.length}` };
          },
        },
      }),
    ]),
    credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
    warnings: [],
  };
}

/**
 * Everything a real install has, mirroring `ramp-raise.test.ts`'s
 * `seedReplyJob`: the unmodified charter (so `email.reply`'s base ceiling is
 * `auto_notify`, never a test-only override) and a live mail binding.
 *
 * Installed exactly ONCE per test and reused by every job it seeds —
 * `charter_versions.charter_version` is a global primary key (migration
 * 001), so a second `installCharter` call under the same business with a
 * fresh version would stamp the first job's `jobs.charter_version` as stale
 * the moment the gate's "current charter" check (stage 2) ran against it.
 * Two jobs comparing "went through a card" against "did not" must sit under
 * one signed charter, exactly as they would on one real install.
 */
async function installFixture(): Promise<PolicyBundle> {
  const bundle = await installCharter(
    buildCharter({
      version: '2026-08-15.autonomous-actions',
      connections: [MAIL_CONNECTION],
      knownCounterpartyEmailDomain: 'example.com',
    }),
    { businessId: BUSINESS },
  );
  await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
  await upsertBinding(
    {
      system: 'office-mail',
      status: 'live',
      endpoint: null,
      credentialRef: 'OFFICE_MAIL',
      lastOkAt: null,
      lastError: null,
    },
    { businessId: BUSINESS, by: 'test' },
  );
  return bundle;
}

/** A boss-provenance job in `execute`, with `plan` bound to it under the given charter. */
async function seedReplyJob(bundle: PolicyBundle, plan: Plan): Promise<string> {
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'תשובה ללקוח',
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  await bindPlanToJob(job.jobId, plan, { businessId: BUSINESS });
  return job.jobId;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('listAutonomousActions', () => {
  it('lists a step that ran with no card at all', async () => {
    const bundle = await installFixture();
    const plan = replyPlan('dana@example.com', 'תשובה');
    const jobId = await seedReplyJob(bundle, plan);
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });

    const sent: MailMessage[] = [];
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });
    expect(result.ran).toEqual([{ jobId, status: 'done', detail: null }]);
    expect(sent).toHaveLength(1);

    const actions = await listAutonomousActions({ businessId: BUSINESS });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      jobId,
      stepId: 's1',
      actionClass: 'email.reply',
      toolName: 'mail.send',
      recipient: 'dana@example.com',
      subject: 'תשובה',
    });
  });

  /**
   * The required negative test. Without the `NOT EXISTS` filter in
   * `listAutonomousActions`, this job's completed step would appear right
   * beside the autonomous one above — it is a real `job_step_results`
   * `completed` row, produced the same way. What must keep it out is that
   * this job's card was actually spent by a human: `applyDecision` here does
   * exactly what clicking "approve" on the dashboard does.
   *
   * Both jobs run under the identical ramp level (`auto_notify`) — the fork
   * between them is the recipient, not the ramp. `dana@example.com` matches
   * the charter's known counterparty domain and clears `scoreVisibility`
   * routine, so `needsApproval`'s ramp-driven term is what would gate it and
   * the ramp already opens it. `stranger@nowhere.example` matches nothing
   * the charter knows, so `needsApproval`'s risk-band term fires regardless
   * of the ramp — the exact shape `ramp-raise.test.ts`'s `STRANGER_PLAN`
   * proves. That keeps this test about the approval filter alone, with no
   * second ramp row to juggle between the two jobs.
   */
  it('does NOT list a step that went out through an approved card', async () => {
    const bundle = await installFixture();
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });

    const autonomousPlan = replyPlan('dana@example.com', 'תשובה');
    const autonomousJobId = await seedReplyJob(bundle, autonomousPlan);

    const cardPlan = replyPlan('stranger@nowhere.example', 'הצעת מחיר');
    const cardJobId = await seedReplyJob(bundle, cardPlan);

    const sent: MailMessage[] = [];
    const runtime = runtimeWith(sent);

    // First pass: the autonomous job sends; the card job parks on an approval.
    const firstPass = await runDueJobs({ businessId: BUSINESS, runtime, now: NOON });
    expect(firstPass.ran).toEqual(
      expect.arrayContaining([
        { jobId: autonomousJobId, status: 'done', detail: null },
        { jobId: cardJobId, status: 'halted', detail: 'awaiting_approval' },
      ]),
    );
    expect(sent).toHaveLength(1);

    // The owner approves the card — exactly what `applyDecision` runs under
    // the dashboard's `/a/:id/approve` route.
    const [pending] = await pendingApprovals({ businessId: BUSINESS });
    if (pending === undefined) throw new Error('expected one pending approval');
    expect(pending.jobId).toBe(cardJobId);
    await applyDecision(
      pending.approvalId,
      'approved',
      { by: 'owner@example.com', channel: 'dashboard' },
      { businessId: BUSINESS },
    );

    // Second pass: the card job resumes, spends the now-approved card, and sends.
    const secondPass = await runDueJobs({ businessId: BUSINESS, runtime, now: NOON });
    expect(secondPass.ran).toEqual([{ jobId: cardJobId, status: 'done', detail: null }]);
    expect(sent).toHaveLength(2);

    const actions = await listAutonomousActions({ businessId: BUSINESS });
    expect(actions.map((a) => a.jobId)).toEqual([autonomousJobId]);
    expect(actions.some((a) => a.jobId === cardJobId)).toBe(false);
  });

  it('returns an empty list for a business with no completed steps', async () => {
    await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), { businessId: BUSINESS });
    expect(await listAutonomousActions({ businessId: BUSINESS })).toEqual([]);
  });
});
