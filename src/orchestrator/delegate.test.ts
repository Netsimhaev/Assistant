import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { contextRefsHash } from '../governance/delegation.js';
import { attachChildJob, loadEnvelope, writeEnvelope } from '../governance/envelope-store.js';
import { canonicalHash } from '../util/canonical.js';
import { insertOrGetDocument, markExtracted } from '../documents/store.js';
import { renderReadingBrief } from '../documents/brief.js';
import { interpretReaderResponse, type ReadOutcome } from '../sdk/know-reader.js';
import type { DocumentArtifact } from '../documents/types.js';
import { AdapterRegistry } from './adapters/registry.js';
import { envCredentials } from './credentials.js';
import { createJob, loadJob, transition, type Job } from './jobs.js';
import { loadPlanBody } from './plan-store.js';
import { rampLevelForPlan } from './ramp.js';
import { runDueJobs } from './run-due.js';
import type { Runtime } from './runtime.js';
import { DelegationAuditUnrecordedError, requestHelp, type RequestHelpInput } from './delegate.js';

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

/** A permissive envelope, overridable, for tests that need a real, attached ancestor. */
function anAncestorEnvelope(overrides: Partial<AgentEnvelope> = {}): AgentEnvelope {
  const id = overrides.id ?? `ENV-${ulid()}`;
  return {
    v: 1,
    id,
    correlationId: 'JOB-root-of-the-tree',
    causalChain: ['ENV-root'],
    from: 'orchestrator',
    to: 'comms.email',
    kind: 'help_request',
    intent: 'an_earlier_intent',
    payload: {},
    contextRefs: [],
    constraints: {
      charterVersion: 'v1',
      provenanceCeiling: 'boss',
      autonomyCeiling: 'auto',
      moneyCeilingMinor: null,
      deadlineAt: '2026-12-31T00:00:00.000Z',
    },
    hops: 2,
    idempotencyKey: `IDEM-${ulid()}`,
    createdAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

/** Persist an ancestor envelope and mark it as having opened `childJobId` — what `envelopeOpenedChild` checks. */
async function seedAncestor(envelope: AgentEnvelope, childJobId: string): Promise<void> {
  await writeEnvelope(envelope, { parentJobId: `JOB-ancestor-of-${childJobId}`, businessId: BUSINESS });
  await attachChildJob(envelope.id, childJobId, { businessId: BUSINESS });
}

async function anExtractedDocument(text: string): Promise<string> {
  const documentId = `DOC-${ulid()}`;
  await insertOrGetDocument(
    {
      documentId,
      source: 'manual',
      originalName: 'מסמך.txt',
      mediaType: 'text/plain',
      sha256: ulid().padEnd(64, '0'),
      byteSize: text.length,
      storedPath: `${BUSINESS}/${documentId}/original.txt`,
    },
    { businessId: BUSINESS },
  );
  await markExtracted(
    documentId,
    [{ ordinal: 0, kind: 'text', partName: 'גוף', content: { blocks: [{ kind: 'paragraph', text }] }, flags: [] }],
    { businessId: BUSINESS },
  );
  return documentId;
}

function stubReader(raw: string) {
  let calls = 0;
  const reader = async (request: { artifacts: readonly DocumentArtifact[] }): Promise<ReadOutcome> => {
    calls += 1;
    const { includedOrdinals } = renderReadingBrief(request.artifacts);
    return interpretReaderResponse(raw, includedOrdinals, [], 1);
  };
  return { reader, callCount: () => calls };
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

    // `attachChildJob` — Task 7 depends on this column entirely
    // (`resumeDelegatedJobs` finds a closed child's parent through it) and
    // nothing was asserting it landed.
    const { rows } = await getPool().query<{ child_job_id: string | null }>(
      'SELECT child_job_id FROM agent_envelopes WHERE business_id = $1 AND envelope_id = $2',
      [BUSINESS, result.envelopeId],
    );
    expect(rows[0]?.child_job_id).toBe(result.childJobId);
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

  /**
   * Also the only test that supplies a `parentEnvelope`, so it is the one
   * that must give it genuinely RESTRICTIVE constraints and assert the child
   * inherits them. A permissive prior envelope (the earlier shape of this
   * test) leaves "ignore `parentEnvelope.constraints` and use the root
   * baseline unconditionally" undetected — see the mutation run below.
   */
  it('the child carries the parent\'s correlation id, not the parent\'s job id — and inherits the ancestor envelope\'s ceiling, not the root baseline', async () => {
    const { job, bundle } = await openParentJob({ provenance: 'boss' });
    const now = new Date('2026-09-24T10:00:00.000Z');
    const priorEnvelope = anAncestorEnvelope({
      constraints: {
        charterVersion: bundle.charterVersion,
        provenanceCeiling: 'unknown_external',
        autonomyCeiling: 'draft_only',
        moneyCeilingMinor: 5000,
        // Earlier than `now + 24h` (this delegation's own contribution), so
        // the ancestor's deadline must be the one that wins.
        deadlineAt: '2026-09-24T11:00:00.000Z',
      },
    });
    await seedAncestor(priorEnvelope, job.jobId);

    const result = await requestHelp(baseRequest(job, bundle, { parentEnvelope: priorEnvelope, now }));
    if (result.status !== 'opened') throw new Error('expected opened');

    const envelope = await loadEnvelope(result.envelopeId, { businessId: BUSINESS });
    expect(envelope?.correlationId).toBe('JOB-root-of-the-tree');
    expect(envelope?.correlationId).not.toBe(job.jobId);
    expect(envelope?.hops).toBe(3);
    expect(envelope?.causalChain).toEqual(['ENV-root', priorEnvelope.id]);

    // The ancestor's ceiling wins over both the root baseline (which this
    // parent, being `boss`-provenance with no restriction of its own, would
    // otherwise pass straight through) AND the parent job's own permissive
    // state.
    expect(envelope?.constraints.provenanceCeiling).toBe('unknown_external');
    expect(envelope?.constraints.autonomyCeiling).toBe('draft_only');
    expect(envelope?.constraints.moneyCeilingMinor).toBe(5000);
    expect(envelope?.constraints.deadlineAt).toBe('2026-09-24T11:00:00.000Z');
  });

  it('refuses at the hop limit', async () => {
    const { job, bundle } = await openParentJob();
    const priorEnvelope = anAncestorEnvelope({
      hops: 6,
      constraints: {
        charterVersion: bundle.charterVersion,
        provenanceCeiling: 'boss',
        autonomyCeiling: 'auto',
        moneyCeilingMinor: null,
        deadlineAt: '2026-12-31T00:00:00.000Z',
      },
    });
    await seedAncestor(priorEnvelope, job.jobId);

    const before = await countJobs();
    const result = await requestHelp(baseRequest(job, bundle, { parentEnvelope: priorEnvelope }));
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected refused');
    expect(result.code).toBe('hop_limit');
    expect(await countJobs()).toBe(before);
  });

  it('refuses a fabricated or stale parentEnvelope that the row does not agree opened this job', async () => {
    const { job, bundle } = await openParentJob();
    // Never written, never attached — the caller's claim alone.
    const fabricated = anAncestorEnvelope();

    const before = await countJobs();
    const result = await requestHelp(baseRequest(job, bundle, { parentEnvelope: fabricated }));
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected refused');
    expect(result.code).toBe('parent_envelope_mismatch');
    expect(await countJobs()).toBe(before);
  });

  it('refuses when the delegating agent is not permitted to reach the receiver', async () => {
    const { job, bundle } = await openParentJob();
    // `ops.web` delegates to nobody (`COLLABORATION_GRAPH`) — the one rule
    // the capability tests say must never be relaxed. `requestHelp` is also
    // called directly (not only as a gated plan step), so it must enforce
    // this itself rather than relying on the gate having already checked it.
    const before = await countJobs();
    const result = await requestHelp(baseRequest(job, bundle, { from: 'ops.web' }));
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected refused');
    expect(result.code).toBe('not_permitted');
    expect(await countJobs()).toBe(before);
    const { rows } = await getPool().query('SELECT 1 FROM agent_envelopes WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(0);
  });

  it('refuses two context refs of the same required kind rather than silently using the first', async () => {
    const { job, bundle } = await openParentJob();
    const result = await requestHelp(
      baseRequest(job, bundle, {
        contextRefs: [
          { kind: 'document', documentId: 'doc-x' },
          { kind: 'document', documentId: 'doc-y' },
        ],
      }),
    );
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected refused');
    expect(result.code).toBe('ambiguous_context_ref');
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

  /**
   * Guard 3 — `writeEnvelope`'s own uniqueness constraint — is deterministically
   * reachable, not merely a theoretical race, once a row exists whose
   * idempotency key already matches what THIS call will compute but whose
   * `correlation_id` says something else. Guard 4 (`priorQuadruples`) is
   * scoped to `correlationId`, so it never sees that row and does not refuse
   * first — proving the two are independent controls, not one hiding the
   * other's absence.
   */
  it('catches a pre-existing envelope under the same idempotency key even when guard 4 cannot see it', async () => {
    const { job, bundle } = await openParentJob();
    const request = baseRequest(job, bundle);
    const refsHash = contextRefsHash(request.contextRefs);
    const idempotencyKey = canonicalHash({
      correlationId: job.jobId, // what requestHelp will use — job is root
      from: request.from,
      to: request.to,
      intent: request.intent,
      contextRefsHash: refsHash,
      payload: request.payload,
    });
    const fabricated = anAncestorEnvelope({
      correlationId: 'JOB-unrelated', // different — guard 4's scoped query misses it
      from: request.from,
      to: request.to,
      intent: request.intent,
      payload: request.payload,
      contextRefs: request.contextRefs,
      hops: 0,
      idempotencyKey,
    });
    await writeEnvelope(fabricated, { parentJobId: 'JOB-unrelated', businessId: BUSINESS });

    const before = await countJobs();
    const result = await requestHelp(request);
    expect(result.status).toBe('duplicate');
    if (result.status !== 'duplicate') throw new Error('expected duplicate');
    expect(result.envelopeId).toBe(fabricated.id);
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

  it('writes an audit row that names the pair and never the payload or what the context refs point at', async () => {
    const { job, bundle } = await openParentJob();
    const secretQuestion = 'מה הסכום החייב בחשבונית מספר 88421?';
    const secretDocumentId = 'DOC-secret-88421';
    const result = await requestHelp(
      baseRequest(job, bundle, {
        payload: { question: secretQuestion },
        contextRefs: [{ kind: 'document', documentId: secretDocumentId }],
      }),
    );
    expect(result.status).toBe('opened');
    if (result.status !== 'opened') throw new Error('expected opened');

    const { rows } = await getPool().query<{ envelope_id: string | null; reason: string }>(
      `SELECT envelope_id, reason FROM audit_log WHERE business_id = $1 AND kind = 'delegation'`,
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.envelope_id).toBe(result.envelopeId);
    expect(rows[0]?.reason).not.toContain(secretQuestion);
    // The second half of "never the payload and never what the context refs
    // point at" — only the payload half was pinned before this round.
    expect(rows[0]?.reason).not.toContain(secretDocumentId);
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
   * delegation run at all — rests on the claim that the child job's every
   * step faces the gate under ITS OWN ramp, never the parent's. This test
   * proves the two `rampLevelForPlan` VALUES are computed independently (the
   * parent's plan and the child's real bound plan give genuinely different
   * answers), which is necessary but, on its own, not sufficient — see the
   * stronger test below it and the fact recorded there.
   */
  it("the child's plan computes its own ramp level, independently of the parent's", async () => {
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

  /**
   * **The fact this pins, plainly:** `doc.fetch` is on `READ_ONLY_TOOLS`, so
   * the child's only step short-circuits at gate STAGE 4 and never reaches
   * stage 8 at all — `ctx.rampLevel` is never even read for it. For today's
   * one registry entry, `CEILING_EXEMPT_TOOLS`'s safety claim is therefore
   * carried in practice by the delegated tool being read-only, NOT by the
   * child running under its own ramp — the previous test proves the ramp
   * VALUES are independent, but a gate decision for `doc.fetch` would come
   * out identically whichever ramp it received. This test instead observes
   * production end to end (`requestHelp` → `runDueJobs`, the real entry
   * point `run-due.ts` uses) and asserts the child actually ran — the
   * strongest claim available against today's registry, and the reason a
   * receiving tool with a real action class is what would make the ramp
   * value itself load-bearing.
   */
  it('the child actually runs to completion through the real scheduler entry point (run-due.ts)', async () => {
    const { job, bundle } = await openParentJob();
    const documentId = await anExtractedDocument('מה המחיר לאספקה?');
    const result = await requestHelp(
      baseRequest(job, bundle, { contextRefs: [{ kind: 'document', documentId }] }),
    );
    if (result.status !== 'opened') throw new Error('expected opened');

    const { reader, callCount } = stubReader(
      JSON.stringify({
        summary: 'שאלה על מחיר אספקה.',
        findings: [],
        intents: [
          {
            intent: 'file_document',
            subject: { kind: 'sender' },
            sourceRef: { ordinal: 0, locator: null },
            note: '',
          },
        ],
        unreadable: [],
      }),
    );
    const runtime: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, 'TEST_CRED_'),
      warnings: [],
    };

    const due = await runDueJobs({ businessId: BUSINESS, runtime, reader });

    const childOutcome = due.ran.find((r) => r.jobId === result.childJobId);
    expect(childOutcome?.status).toBe('done');
    expect(callCount()).toBe(1);

    const childAfter = await loadJob(result.childJobId, { businessId: BUSINESS });
    expect(childAfter?.phase).toBe('verify');
  });
});

describe('appendAudit failure after the delegation has already committed', () => {
  /**
   * A sentinel that forces the audit insert to fail, without stubbing
   * `appendAudit` — same harness as `src/governance/killswitch.test.ts` and
   * `src/governance/erasure.test.ts`'s `installAuditFailureTrigger`, keyed on
   * `NEW.kind = 'delegation'` instead.
   */
  async function installDelegationAuditFailureTrigger(): Promise<void> {
    await getPool().query(`
      CREATE OR REPLACE FUNCTION test_force_delegation_audit_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW.kind = 'delegation' THEN
          RAISE EXCEPTION 'forced delegation audit failure for test';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS force_delegation_audit_failure ON audit_log;
      CREATE TRIGGER force_delegation_audit_failure
        BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION test_force_delegation_audit_failure();
    `);
  }

  async function removeDelegationAuditFailureTrigger(): Promise<void> {
    await getPool().query('DROP TRIGGER IF EXISTS force_delegation_audit_failure ON audit_log');
  }

  afterEach(async () => {
    await removeDelegationAuditFailureTrigger();
  });

  it('throws DelegationAuditUnrecordedError carrying the real, completed outcome', async () => {
    await installDelegationAuditFailureTrigger();
    const { job, bundle } = await openParentJob();

    let caught: unknown;
    try {
      await requestHelp(baseRequest(job, bundle));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DelegationAuditUnrecordedError);
    const typed = caught as DelegationAuditUnrecordedError;
    expect(typed.delegated).toBe(true);
    expect(typed.outcome.parentJobId).toBe(job.jobId);
    expect(typed.cause).toBeInstanceOf(Error);
    expect((typed.cause as Error).message).toContain('forced delegation audit failure');

    // The delegation IS in effect despite the failed audit row: the child
    // exists and the parent is parked, exactly as a successful call would
    // leave them.
    const child = await loadJob(typed.outcome.childJobId, { businessId: BUSINESS });
    expect(child).not.toBeNull();
    const parentAfter = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(parentAfter?.phase).toBe('followup');
  });
});
