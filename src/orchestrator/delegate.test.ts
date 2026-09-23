import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { config } from '../config.js';
import type { AgentEnvelope } from '../domain/envelope.js';
import type { PolicyBundle } from '../domain/policy.js';
import { Plan } from '../domain/plan.js';
import type { TrustLevel } from '../domain/trust.js';
import { loadEnvelope } from '../governance/envelope-store.js';
import { createJob, loadJob, transition, type Job } from './jobs.js';
import { loadPlanBody } from './plan-store.js';
import { rampLevelForPlan } from './ramp.js';
import { requestHelp, type RequestHelpInput } from './delegate.js';

const BUSINESS = 'test-business';

async function openParentJob(
  options: { provenance?: TrustLevel; version?: string } = {},
): Promise<{ job: Job; bundle: PolicyBundle }> {
  const bundle = await installCharter(buildCharter({ version: options.version ?? `parent-${ulid()}` }), {
    businessId: BUSINESS,
  });
  const created = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: options.provenance ?? 'boss',
    businessId: BUSINESS,
    title: 'delegating job',
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(created.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const job = await loadJob(created.jobId, { businessId: BUSINESS });
  if (job === null) throw new Error('parent job vanished');
  return { job, bundle };
}

function baseRequest(
  job: Job,
  bundle: PolicyBundle,
  overrides: Partial<RequestHelpInput> = {},
): RequestHelpInput {
  return {
    parentJobId: job.jobId,
    from: 'comms.email',
    to: 'know.reader',
    intent: 'read_for_question',
    payload: { question: 'מה המסמך הזה מבקש?' },
    contextRefs: [{ kind: 'document', documentId: 'doc-1' }],
    bundle,
    parentEnvelope: null,
    businessId: BUSINESS,
    ...overrides,
  };
}

async function countJobs(): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    'SELECT count(*)::text AS n FROM jobs WHERE business_id = $1',
    [BUSINESS],
  );
  return Number(rows[0]?.n ?? '0');
}

/** Move a parent back to `execute`, as if a scheduler retried its step. */
async function retryParent(jobId: string): Promise<void> {
  await transition(jobId, { to: 'execute', actor: 'orchestrator', reason: 'retry', businessId: BUSINESS });
}

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('requestHelp', () => {
  it('opens a child job and parks the parent on the envelope', async () => {
    const { job, bundle } = await openParentJob();
    const result = await requestHelp(baseRequest(job, bundle));
    expect(result.status).toBe('opened');
    if (result.status !== 'opened') throw new Error('expected opened');

    const parentAfter = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(parentAfter?.phase).toBe('followup');
    expect(parentAfter?.awaitingEnvelopeId).toBe(result.envelopeId);

    const child = await loadJob(result.childJobId, { businessId: BUSINESS });
    expect(child).not.toBeNull();
    expect(child?.phase).toBe('execute');

    const plan = await loadPlanBody(result.childJobId, { businessId: BUSINESS });
    expect(plan).not.toBeNull();
    expect(plan?.plan.steps).toHaveLength(1);
    expect(plan?.plan.steps[0]?.toolName).toBe('doc.fetch');
    expect(plan?.plan.steps[0]?.agent).toBe('know.reader');
  });

  /** This is the central assertion of the whole plan. */
  it('the child\'s constraints are tightened in every field, never loosened', async () => {
    const { job, bundle } = await openParentJob({ provenance: 'staff' });
    const now = new Date('2026-09-24T10:00:00.000Z');
    const result = await requestHelp(baseRequest(job, bundle, { now }));
    if (result.status !== 'opened') throw new Error('expected opened');

    const envelope = await loadEnvelope(result.envelopeId, { businessId: BUSINESS });
    expect(envelope).not.toBeNull();
    // The parent job's own provenance ('staff') is stricter than the root
    // ancestor's unrestricted baseline ('boss'), and it is the one that must
    // win — the opposite of what "pass the parent's constraints through
    // unchanged" would produce (see the mutation this task's brief names).
    expect(envelope?.constraints.provenanceCeiling).toBe('staff');
    expect(envelope?.constraints.autonomyCeiling).toBe('auto');
    expect(envelope?.constraints.moneyCeilingMinor).toBeNull();
    // Tightened here too: the root ancestor's sentinel deadline is far in the
    // future, and the finite window this delegation itself contributes must
    // be the one that wins.
    expect(envelope?.constraints.deadlineAt).toBe(
      new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it('the child carries the parent\'s correlation id, not the parent\'s job id', async () => {
    const { job, bundle } = await openParentJob();
    const priorEnvelope: AgentEnvelope = {
      v: 1,
      id: `ENV-${ulid()}`,
      correlationId: 'JOB-root-of-the-tree',
      causalChain: ['ENV-root'],
      from: 'orchestrator',
      to: 'comms.email',
      kind: 'help_request',
      intent: 'an_earlier_intent',
      payload: {},
      contextRefs: [],
      constraints: {
        charterVersion: bundle.charterVersion,
        provenanceCeiling: 'boss',
        autonomyCeiling: 'auto',
        moneyCeilingMinor: null,
        deadlineAt: '2026-12-31T00:00:00.000Z',
      },
      hops: 2,
      idempotencyKey: `IDEM-${ulid()}`,
      createdAt: '2026-09-24T00:00:00.000Z',
    };

    const result = await requestHelp(baseRequest(job, bundle, { parentEnvelope: priorEnvelope }));
    if (result.status !== 'opened') throw new Error('expected opened');

    const envelope = await loadEnvelope(result.envelopeId, { businessId: BUSINESS });
    expect(envelope?.correlationId).toBe('JOB-root-of-the-tree');
    expect(envelope?.correlationId).not.toBe(job.jobId);
    expect(envelope?.hops).toBe(3);
    expect(envelope?.causalChain).toEqual(['ENV-root', priorEnvelope.id]);
  });

  it('refuses a second identical request and opens no second child', async () => {
    const { job, bundle } = await openParentJob();
    const request = baseRequest(job, bundle);
    const first = await requestHelp(request);
    expect(first.status).toBe('opened');
    await retryParent(job.jobId);

    const before = await countJobs();
    const second = await requestHelp(request);
    expect(second.status).not.toBe('opened');
    expect(await countJobs()).toBe(before);
  });

  it('refuses a repeat of the same quadruple with no new context', async () => {
    const { job, bundle } = await openParentJob();
    const first = await requestHelp(
      baseRequest(job, bundle, { payload: { question: 'שאלה ראשונה על המסמך' } }),
    );
    expect(first.status).toBe('opened');
    await retryParent(job.jobId);

    // A DIFFERENT payload (so the idempotency key differs and guard 3 would
    // not fire) but the SAME (from, to, intent, contextRefsHash) — guard 4
    // must still refuse it.
    const second = await requestHelp(
      baseRequest(job, bundle, { payload: { question: 'שאלה אחרת לגמרי על אותו מסמך' } }),
    );
    expect(second.status).toBe('refused');
    if (second.status !== 'refused') throw new Error('expected refused');
    expect(second.code).toBe('no_new_information');
  });

  it('fails the parent job on the third exchange between the same pair', async () => {
    const { job, bundle } = await openParentJob();

    const first = await requestHelp(
      baseRequest(job, bundle, { contextRefs: [{ kind: 'document', documentId: 'doc-a' }] }),
    );
    expect(first.status).toBe('opened');
    await retryParent(job.jobId);

    const second = await requestHelp(
      baseRequest(job, bundle, { contextRefs: [{ kind: 'document', documentId: 'doc-b' }] }),
    );
    expect(second.status).toBe('opened');
    await retryParent(job.jobId);

    const third = await requestHelp(
      baseRequest(job, bundle, { contextRefs: [{ kind: 'document', documentId: 'doc-c' }] }),
    );
    expect(third.status).toBe('refused');
    if (third.status !== 'refused') throw new Error('expected refused');
    expect(third.code).toBe('oscillation');
    expect(third.reason).toContain('comms.email');
    expect(third.reason).toContain('know.reader');

    const parentAfter = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(parentAfter?.phase).toBe('failed');
  });

  it('refuses when the daily cap is used up', async () => {
    const { job, bundle } = await openParentJob();
    for (let i = 0; i < config.delegationsPerDay; i++) {
      await getPool().query(
        `INSERT INTO audit_log (
           business_id, actor, kind, charter_version, provenance, input_hash, reason, prev_hash, hash
         ) VALUES ($1, 'orchestrator', 'delegation', $2, 'boss', 'seed', 'seed row', $3, $4)`,
        [BUSINESS, bundle.charterVersion, '0'.repeat(64), i.toString(16).padStart(64, '0')],
      );
    }

    const result = await requestHelp(baseRequest(job, bundle));
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected refused');
    expect(result.code).toBe('daily_cap');

    const { rows } = await getPool().query('SELECT 1 FROM agent_envelopes WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(0);
  });

  it('refuses an unregistered intent', async () => {
    const { job, bundle } = await openParentJob();
    const result = await requestHelp(baseRequest(job, bundle, { intent: 'no_such_intent' }));
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected refused');
    expect(result.code).toBe('unknown_intent');
  });

  it('refuses a missing required context ref', async () => {
    const { job, bundle } = await openParentJob();
    const result = await requestHelp(baseRequest(job, bundle, { contextRefs: [] }));
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected refused');
    expect(result.code).toBe('missing_context_ref');
  });

  it('writes an audit row that names the pair and never the payload', async () => {
    const { job, bundle } = await openParentJob();
    const secretQuestion = 'מה הסכום החייב בחשבונית מספר 88421?';
    const result = await requestHelp(baseRequest(job, bundle, { payload: { question: secretQuestion } }));
    expect(result.status).toBe('opened');
    if (result.status !== 'opened') throw new Error('expected opened');

    const { rows } = await getPool().query<{ envelope_id: string | null; reason: string }>(
      `SELECT envelope_id, reason FROM audit_log WHERE business_id = $1 AND kind = 'delegation'`,
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.envelope_id).toBe(result.envelopeId);
    expect(rows[0]?.reason).not.toContain(secretQuestion);
    expect(rows[0]?.reason).toContain('comms.email');
    expect(rows[0]?.reason).toContain('know.reader');
  });

  it('refuses to delegate from a job that is not in execute', async () => {
    const { job, bundle } = await openParentJob();
    await transition(job.jobId, {
      to: 'verify',
      actor: 'orchestrator',
      reason: 'no longer executing',
      businessId: BUSINESS,
    });

    const before = await countJobs();
    const result = await requestHelp(baseRequest(job, bundle));
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected refused');
    expect(result.code).toBe('job_not_executable');
    expect(await countJobs()).toBe(before);

    const { rows } = await getPool().query('SELECT 1 FROM agent_envelopes WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(0);
  });

  /**
   * `CEILING_EXEMPT_TOOLS` — the thing that lets a plan containing a
   * delegation run at all — rests entirely on the claim that the child job's
   * every step faces the gate under ITS OWN ramp, never the parent's. Nothing
   * tested that before this. The parent's plan (one `agent.request_help`
   * step, classified but ceiling-exempt) and the child's real bound plan (one
   * `doc.fetch` step, read-only and not exempt) must compute to genuinely
   * different ramp levels — proving the two are independent rather than one
   * being copied onto the other.
   */
  it("the child's plan is gated under its own ramp level, not the parent's", async () => {
    const { job, bundle } = await openParentJob();
    const result = await requestHelp(baseRequest(job, bundle));
    if (result.status !== 'opened') throw new Error('expected opened');

    const parentPlan = Plan.parse({
      goal: 'delegate to know.reader',
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'ask know.reader what the document wants',
          toolName: 'agent.request_help',
          input: { to: 'know.reader', intent: 'read_for_question', payload: {}, contextRefs: [] },
          expectedActionClass: 'agent.delegate',
        },
      ],
    });
    const parentRamp = await rampLevelForPlan(parentPlan, { businessId: BUSINESS });
    // The exemption's whole point: a delegation carries no outbound authority
    // of its own and must not floor the plan that contains it.
    expect(parentRamp).toBe('auto');

    const childPlanBody = await loadPlanBody(result.childJobId, { businessId: BUSINESS });
    if (childPlanBody === null) throw new Error('expected the child\'s bound plan');
    const childRamp = await rampLevelForPlan(childPlanBody.plan, { businessId: BUSINESS });
    // `doc.fetch` is read-only and NOT ceiling-exempt, so it floors at the
    // ramp floor — genuinely computed from the child's own plan, not carried
    // over from the parent's.
    expect(childRamp).toBe('draft_only');

    expect(childRamp).not.toBe(parentRamp);
  });
});
