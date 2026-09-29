import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import { grantAuthorization } from '../governance/authorization.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import { envCredentials } from './credentials.js';
import { createJob, loadJob, markContentIngested, transition } from './jobs.js';
import { runPlan, type RunPlanResult } from './run-plan.js';

const BUSINESS = 'test-business';
const PREFIX = 'TEST_CRED_';
const NOON = new Date('2026-08-18T09:00:00.000Z');

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail', label: 'תיבת המשרד', channel: 'api',
  serves: ['mail.send'], target: null, subprocessor: null,
};

const LIVE: ConnectionBinding = {
  system: 'office-mail', status: 'live', endpoint: null,
  credentialRef: 'OFFICE_MAIL', provider: null, lastOkAt: null, lastError: null,
};

/** One step, to a stranger, with nothing read. The live thread's own plan. */
const SEND_ONLY: Plan = Plan.parse({
  goal: 'send one mail',
  steps: [{
    id: 's1', agent: 'comms.email', intent: 'send',
    toolName: 'mail.send',
    input: { to: 'stranger@example.com', subject: 'הצעה', body: 'שלום' },
    expectedActionClass: 'email.initiate',
  }],
});

function registry(sent: MailMessage[]): AdapterRegistry {
  return new AdapterRegistry([
    createMailAdapter({
      system: 'office-mail',
      transport: { async send(m) { sent.push(m); return { messageId: 'MSG-1' }; } },
    }),
  ]);
}

/**
 * Asserts the run halted for exactly the reason named, not merely that it
 * halted. `RunPlanResult['halted']` covers a queued approval, a quiet-hours
 * deferral and any denial alike — three very different outcomes for a job —
 * and a bare `toBe('halted')` cannot tell them apart. Narrowing here (rather
 * than at each call site) is what lets every negative test in this file state
 * which halt it expects.
 */
function expectHalted(result: RunPlanResult, reason: string): void {
  expect(result.status).toBe('halted');
  if (result.status !== 'halted') throw new Error('expected a halted result');
  expect(result.reason).toBe(reason);
}

async function jobInExecute(bundle: { charterVersion: string }, provenance: 'boss' | 'staff' = 'boss') {
  const job = await createJob({
    charterVersion: bundle.charterVersion, provenance, businessId: BUSINESS,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

/**
 * The charter must permit the class, or its own ceiling forces an approval
 * regardless of the exemption — see the spec's §6. This is the charter change
 * the owner would make in production, expressed as a test override.
 */
function permissiveCharter() {
  return buildCharter({
    connections: [MAIL_CONNECTION],
    autonomyBase: { 'email.initiate': 'auto' },
  });
}

describe('a boss origin is no longer an exemption, and what replaced it', () => {
  beforeEach(async () => { await resetDatabase(); });
  afterAll(async () => { await closePool(); });

  /**
   * This test asserted the opposite until 10/09, and the reversal is the
   * point of the change rather than a casualty of it.
   *
   * `FIRST_CONTACT_EXEMPT` held `boss`, so a chain the owner started that had
   * read nothing did not escalate on a recipient the charter could not
   * resolve. `stranger@example.com` is exactly that recipient, and this test
   * watched a real message leave for it with no card. Nothing had ever
   * exercised that in production — the ramp held every outbound class at
   * `draft_only`, so the gate denied on autonomy before the band mattered —
   * and the first time a raised ramp made it reachable, this is the shape it
   * took.
   *
   * The set is empty now. What the owner wanted from it is asserted in the
   * next test, by the mechanism that can actually express it.
   */
  it('asks even when the boss instructed it and nothing was read', async () => {
    const bundle = await installCharter(permissiveCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle);
    const sent: MailMessage[] = [];

    const result = await runPlan({
      job, bundle, plan: SEND_ONLY, registry: registry(sent), bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [], rampLevel: 'auto', now: NOON,
    });

    expectHalted(result, 'awaiting_approval');
    expect(sent).toEqual([]);
  });

  /**
   * The replacement, end to end through the same call.
   *
   * The owner's rule is that a recipient counts as known once they have typed
   * it, and the instruction door writes exactly that: a standing
   * authorisation naming the recipients the instruction contained. It cancels
   * the same risk-band term the exemption used to cancel, and reaches no
   * further — a recipient nobody named stays behind a card, as the test above
   * now shows.
   *
   * Same job, same plan, same unresolved address as above. The grant is the
   * only difference.
   */
  it('sends when the owner’s own instruction named that recipient', async () => {
    const bundle = await installCharter(permissiveCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle);
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.initiate', recipients: ['stranger@example.com'] },
      { businessId: BUSINESS },
    );
    const sent: MailMessage[] = [];

    const result = await runPlan({
      job, bundle, plan: SEND_ONLY, registry: registry(sent), bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [], rampLevel: 'auto', now: NOON,
    });

    expect(result.status).toBe('done');
    expect(sent).toHaveLength(1);
  });

  it('still asks when the job has already ingested content', async () => {
    const bundle = await installCharter(permissiveCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle);
    await markContentIngested(job.jobId, { businessId: BUSINESS });
    const fresh = await loadJob(job.jobId, { businessId: BUSINESS });
    if (fresh === null) throw new Error('job vanished');
    const sent: MailMessage[] = [];

    const result = await runPlan({
      job: fresh, bundle, plan: SEND_ONLY, registry: registry(sent), bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [], rampLevel: 'auto', now: NOON,
    });

    // Kept after the exempt set was emptied, and still worth its place: it
    // pins `runPlan`'s `!job.contentIngested` conjunct. The outcome no longer
    // depends on the exemption — a stranger queues for approval either way —
    // but if the set is ever re-populated, this is the test that says a job
    // which has read a document does not get the relaxation back. Note it
    // queues rather than being refused outright, which is the distinction the
    // reason string carries.
    expectHalted(result, 'awaiting_approval');
    expect(sent).toEqual([]);
  });

  it('still asks when the plan itself contains a reader, even after the send step', async () => {
    const bundle = await installCharter(permissiveCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle);
    const sent: MailMessage[] = [];

    // The reader comes SECOND. Execution order must not matter: the planner
    // that wrote step 1 is the same planner that had read for step 2.
    const readAfter: Plan = Plan.parse({
      goal: 'send then read',
      steps: [
        SEND_ONLY.steps[0],
        { id: 's2', agent: 'know.reader', intent: 'read', toolName: 'doc.fetch',
          input: { uri: 'https://example.com/d' }, dependsOn: ['s1'],
          expectedActionClass: null },
      ],
    });

    const result = await runPlan({
      job, bundle, plan: readAfter, registry: registry(sent), bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [], rampLevel: 'auto', now: NOON,
    });

    expectHalted(result, 'awaiting_approval');
    expect(sent).toEqual([]);
  });

  /**
   * `unknown_external` was tried here first and rejected: its provenance
   * ceiling (`PROVENANCE_CEILING` in `src/test/fixtures.ts`) is `draft_only`,
   * so `effectiveAutonomy` denies the step at the gate's autonomy step (step
   * 8) — before `assessRisk` ever runs. That exercises `draft_only`, not the
   * first-contact escalation this test is named for.
   *
   * `staff` has a ceiling of `auto_notify` (see `PROVENANCE_CEILING`), which
   * — combined with this test's permissive charter (`autonomyBase:
   * 'email.initiate': 'auto'`) and `rampLevel: 'auto'` — is not restrictive
   * enough to deny on its own. The step reaches `assessRisk`, the recipient
   * is an unresolved stranger (`one_unknown`), so `isUnvettedFirstContact`
   * returns `true` and the band is `sensitive` — which is what actually
   * queues the approval here, not an autonomy ceiling.
   *
   * Since 10/09 the exempt set is empty, so `staff` and `boss` now reach the
   * same outcome and this test no longer distinguishes them by itself. It is
   * kept because the path it exercises — reaching `assessRisk` rather than
   * being stopped at the autonomy ceiling — is what makes the assertion mean
   * "the band escalated" instead of "some ceiling denied", and that is the
   * property most easily lost by a later edit to the fixture's ceilings.
   */
  it('still asks when the job did not come from the boss', async () => {
    const bundle = await installCharter(permissiveCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle, 'staff');
    const sent: MailMessage[] = [];

    const result = await runPlan({
      job, bundle, plan: SEND_ONLY, registry: registry(sent), bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [], rampLevel: 'auto', now: NOON,
    });

    expectHalted(result, 'awaiting_approval');
    expect(sent).toEqual([]);
  });
});
