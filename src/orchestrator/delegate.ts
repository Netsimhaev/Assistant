/**
 * `requestHelp` — what actually happens when one agent asks another for help.
 *
 * A delegation opens a CHILD JOB with its own one-step plan, never a step
 * appended to the parent's — `bindPlanToJob` refuses a changed plan once any
 * step of a job has a result row, and that guard was built against a real
 * double-order (`plan-store.ts`). The parent moves `execute → followup` and
 * waits; the child runs like any other job, through the full ten-stage gate,
 * under its own ramp.
 *
 * **This composes several already-atomic writes, not one SQL transaction.**
 * `createJob`, `bindPlanToJob` and `transition` each manage their own
 * connection and cannot be threaded onto a caller-supplied one without
 * widening their signatures, which is out of scope for this work (`createJob`
 * and `bindPlanToJob` are interfaces this task consumes rather than owns; even
 * `transition`, which this task does touch, keeps its own internal
 * transaction and `FOR UPDATE` lock unchanged). The ordering below (envelope,
 * then child, then plan, then attach, then park the parent)
 * is chosen so that a crash after `writeEnvelope` but before the parent is
 * parked leaves a durable, idempotent trace — a retry with the same inputs
 * hits the same idempotency key — rather than a duplicate child. It does not
 * close the window entirely: a crash between `createJob` and `attachChildJob`
 * leaves an orphaned child with a plan bound and no envelope pointing at it,
 * and a retry sees `duplicate` and returns without repairing that. This is
 * the same physical limit `recordStepCompletion` already documents for a
 * crash between an adapter call and its completion row — at-least-once, not
 * exactly-once, and the honest thing to do is name the window rather than
 * pretend a single function call can make it disappear.
 */
import { ulid } from 'ulid';
import { config } from '../config.js';
import type { AgentId } from '../domain/audit.js';
import type { AgentEnvelope, ContextRef, EnvelopeConstraints } from '../domain/envelope.js';
import type { Plan } from '../domain/plan.js';
import type { PolicyBundle } from '../domain/policy.js';
import { classifyAction } from '../policy/classify.js';
import { appendAudit } from '../audit/log.js';
import {
  contextRefsHash,
  dailyCapGuard,
  hopGuard,
  noNewInformationGuard,
  oscillationGuard,
  tightenConstraints,
  type DelegationDenial,
} from '../governance/delegation.js';
import {
  attachChildJob,
  countPairExchanges,
  delegationsToday,
  priorQuadruples,
  writeEnvelope,
} from '../governance/envelope-store.js';
import { resolveIntent, type IntentSpec } from '../governance/intent-registry.js';
import { canonicalHash } from '../util/canonical.js';
import { createJob, loadJob, transition } from './jobs.js';
import { bindPlanToJob } from './plan-store.js';

/**
 * The ceiling a job with no incoming envelope inherits from — maximally
 * permissive on every field, because nothing above a root job restricts it
 * yet. The delegation's actual restriction, for the common case, comes
 * entirely from the OTHER half of `tightenConstraints`'s inputs: the
 * requesting job's own current state (see `jobDerivedConstraints` in
 * `requestHelp`). `deadlineAt` is a sentinel far enough out that it can never
 * be the tighter of the two — a root ancestor must not accidentally impose a
 * deadline nobody set.
 */
const ROOT_ANCESTOR_CONSTRAINTS: Omit<EnvelopeConstraints, 'charterVersion'> = {
  provenanceCeiling: 'boss',
  autonomyCeiling: 'auto',
  moneyCeilingMinor: null,
  deadlineAt: '9999-12-31T00:00:00.000Z',
};

/**
 * How long a parent is willing to wait for an answer, absent a tighter
 * ancestor deadline. Real and finite, unlike the sentinel above — this is the
 * value that actually governs a root delegation's `deadlineAt`.
 */
const DEFAULT_DELEGATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RequestHelpInput {
  parentJobId: string;
  from: AgentId;
  to: AgentId;
  intent: string;
  payload: unknown;
  contextRefs: ContextRef[];
  bundle: PolicyBundle;
  /**
   * The envelope that caused the PARENT job itself to run, or `null` when the
   * parent is a root job — one whose provenance and constraints come from
   * nowhere but its own row. Required rather than defaulted: `requestHelp` has
   * no reliable way to discover this on its own (a job may have more than one
   * `agent_envelopes` row naming it as `child_job_id` only by construction
   * accident, never legitimately, and guessing which one governs is exactly
   * the kind of silent default this codebase does not make). The caller that
   * is actually executing the parent's plan step already knows which envelope
   * it is running under, if any.
   */
  parentEnvelope: AgentEnvelope | null;
  businessId?: string;
  now?: Date;
}

export type RequestHelpDenialCode =
  | 'job_not_executable'
  | 'unknown_intent'
  | 'payload_schema'
  | 'missing_context_ref'
  | DelegationDenial['code'];

export type RequestHelpResult =
  | { status: 'opened'; envelopeId: string; childJobId: string }
  /** The same request was already made — no second child was opened. */
  | { status: 'duplicate'; envelopeId: string }
  | { status: 'refused'; code: RequestHelpDenialCode; reason: string };

export interface DelegationOutcome {
  envelopeId: string;
  childJobId: string;
  parentJobId: string;
}

/**
 * The envelope was written, the child was opened and bound, and the parent
 * was parked — and then the audit row describing it failed to append.
 *
 * Same shape as `ErasureAuditUnrecordedError` (`src/governance/erasure.ts`)
 * and `RotationAuditUnrecordedError` (`src/cli/secret-key.ts`), and for the
 * same reason: once the irreversible half has already committed, the only
 * honest failure left is "it happened, and the record of it is missing" —
 * never "it didn't happen" and never silence.
 */
export class DelegationAuditUnrecordedError extends Error {
  readonly delegated = true as const;
  readonly outcome: DelegationOutcome;

  constructor(outcome: DelegationOutcome, cause: unknown) {
    super(
      `a delegation opened child job ${outcome.childJobId} from parent ${outcome.parentJobId} ` +
        `(envelope ${outcome.envelopeId}) but the audit entry recording it failed to write. ` +
        `The delegation IS in effect; the record of it is missing and must be reconstructed manually.`,
      { cause },
    );
    this.name = 'DelegationAuditUnrecordedError';
    this.outcome = outcome;
  }
}

/** `payload` merged with the resolved context ref's own field — see `contextRefField`. */
function buildStepInput(
  payload: unknown,
  requiresContextRef: IntentSpec['requiresContextRef'],
  ref: ContextRef | null,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : {};
  if (requiresContextRef === null || ref === null) return base;
  return { ...base, ...contextRefField(ref) };
}

/**
 * A `ContextRef` carries a pointer, never text (`domain/envelope.ts`). This is
 * where the pointer is followed: the child's one step needs the actual field
 * a local tool reads (`documentId` for `doc.fetch`, and so on), not the
 * envelope's wrapper around it.
 */
function contextRefField(ref: ContextRef): Record<string, string> {
  switch (ref.kind) {
    case 'document':
      return { documentId: ref.documentId };
    case 'reading':
      return { readingId: ref.readingId };
    case 'memory':
      return { memoryId: ref.memoryId };
    case 'job':
      return { jobId: ref.jobId };
  }
}

export async function requestHelp(input: RequestHelpInput): Promise<RequestHelpResult> {
  const businessId = input.businessId ?? config.businessId;
  const now = input.now ?? new Date();

  // 1. The parent must be executing, checked before any write — the same
  // reasoning `runPlan` applies to its own phase check.
  const parent = await loadJob(input.parentJobId, { businessId });
  if (parent === null || parent.phase !== 'execute') {
    return {
      status: 'refused',
      code: 'job_not_executable',
      reason:
        parent === null
          ? `המשימה ${input.parentJobId} אינה קיימת`
          : `המשימה ${parent.jobId} נמצאת בשלב ${parent.phase}, לא ב-execute`,
    };
  }

  // 2. Resolve the intent, validate the payload, and require the context ref
  // the registry declares.
  const spec = resolveIntent(input.to, input.intent);
  if (spec === null) {
    return {
      status: 'refused',
      code: 'unknown_intent',
      reason: `${input.to} אינו מקבל את הכוונה "${input.intent}"`,
    };
  }
  const parsedPayload = spec.payload.safeParse(input.payload);
  if (!parsedPayload.success) {
    const first = parsedPayload.error.issues[0];
    const where = first === undefined ? '' : ` (${first.path.join('.') || 'root'}: ${first.message})`;
    return {
      status: 'refused',
      code: 'payload_schema',
      reason: `המטען אינו תואם את סכמת "${input.intent}"${where}`,
    };
  }
  const matchingRef =
    spec.requiresContextRef === null
      ? null
      : (input.contextRefs.find((ref) => ref.kind === spec.requiresContextRef) ?? null);
  if (spec.requiresContextRef !== null && matchingRef === null) {
    return {
      status: 'refused',
      code: 'missing_context_ref',
      reason: `הכוונה "${input.intent}" דורשת מצביע מסוג ${spec.requiresContextRef} וכזה לא סופק`,
    };
  }

  // Ancestry: inherited from the parent's own incoming envelope when it has
  // one, otherwise this is the root of a new tree.
  const parentHops = input.parentEnvelope?.hops ?? 0;
  const correlationId = input.parentEnvelope?.correlationId ?? parent.jobId;
  const causalChain = input.parentEnvelope
    ? [...input.parentEnvelope.causalChain, input.parentEnvelope.id]
    : [];
  const ancestorConstraints: EnvelopeConstraints =
    input.parentEnvelope?.constraints ?? {
      charterVersion: input.bundle.charterVersion,
      ...ROOT_ANCESTOR_CONSTRAINTS,
    };
  // What THIS delegation contributes on top of the ancestor ceiling: the
  // parent JOB's own current state. `tightenConstraints` takes the stricter
  // of the two — this is where a parent that is itself less trusted than its
  // ancestors is the one that actually narrows the child.
  const jobDerivedConstraints: Partial<EnvelopeConstraints> = {
    provenanceCeiling: parent.provenance,
    autonomyCeiling: 'auto',
    moneyCeilingMinor: null,
    deadlineAt: new Date(now.getTime() + DEFAULT_DELEGATION_WINDOW_MS).toISOString(),
  };

  // 3. The guards this function owns. Hop limit, daily cap, no-new-information,
  // oscillation — the graph (who may ask whom) was already checked by the gate
  // before `requestHelp` was ever called, and idempotency is `writeEnvelope`'s
  // own unique constraint, checked in step 4 below.
  const hopDenial = hopGuard(parentHops);
  if (hopDenial !== null) return { status: 'refused', ...hopDenial };

  const usedToday = await delegationsToday({ businessId });
  const capDenial = dailyCapGuard(usedToday, config.delegationsPerDay);
  if (capDenial !== null) return { status: 'refused', ...capDenial };

  const refsHash = contextRefsHash(input.contextRefs);
  const prior = await priorQuadruples(correlationId, { businessId });
  const noInfoDenial = noNewInformationGuard(
    { from: input.from, to: input.to, intent: input.intent, contextRefsHash: refsHash },
    prior,
  );
  if (noInfoDenial !== null) return { status: 'refused', ...noInfoDenial };

  const exchanges = await countPairExchanges(correlationId, input.from, input.to, input.intent, {
    businessId,
  });
  const oscillationDenial = oscillationGuard(exchanges);
  if (oscillationDenial !== null) {
    // The reason is enriched with the pair and the intent here rather than
    // relying on `oscillationDenial.reason` alone (which, by design, names
    // neither): both the failed parent's `job_steps` row and the refusal
    // returned to the caller must name the two agents, so whoever reads
    // either one can tell who disagreed with whom.
    const named =
      `${oscillationDenial.reason} — ${input.from} ↔ ${input.to}, ` +
      `כוונה: "${input.intent}"`;
    // The only guard that also fails the parent — a disagreement between two
    // agents is a signal a human should see, not one a third agent resolves.
    await transition(parent.jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: named,
      businessId,
    });
    return { status: 'refused', code: oscillationDenial.code, reason: named };
  }

  // 4. Write the envelope, open the child, bind its one-step plan, attach it,
  // and park the parent. See this module's docblock for why this is a
  // sequence of already-atomic writes rather than one transaction.
  const constraints = tightenConstraints(ancestorConstraints, jobDerivedConstraints);
  const stepInput = buildStepInput(parsedPayload.data, spec.requiresContextRef, matchingRef);

  const envelope: AgentEnvelope = {
    v: 1,
    id: `ENV-${ulid()}`,
    correlationId,
    causalChain,
    from: input.from,
    to: input.to,
    kind: 'help_request',
    intent: input.intent,
    payload: parsedPayload.data,
    contextRefs: input.contextRefs,
    constraints,
    hops: parentHops + 1,
    idempotencyKey: canonicalHash({
      correlationId,
      from: input.from,
      to: input.to,
      intent: input.intent,
      contextRefsHash: refsHash,
      payload: parsedPayload.data,
    }),
    createdAt: now.toISOString(),
  };

  const written = await writeEnvelope(envelope, { parentJobId: parent.jobId, businessId });
  if (written.status === 'duplicate') {
    return { status: 'duplicate', envelopeId: written.envelope.id };
  }

  const child = await createJob({
    charterVersion: constraints.charterVersion,
    provenance: constraints.provenanceCeiling,
    title: `בקשת עזרה: ${input.intent} (מ-${input.from})`,
    businessId,
  });

  const childPlan: Plan = {
    goal: `${input.intent} עבור ${input.from}`,
    assumptions: [],
    clarifyingQuestion: null,
    steps: [
      {
        id: 'help',
        agent: input.to,
        intent: input.intent,
        toolName: spec.tool,
        input: stepInput,
        dependsOn: [],
        expectedActionClass: classifyAction(spec.tool),
      },
    ],
    estimatedCostMinor: 0,
  };

  // The child is a real job and walks the same phase machine as any other —
  // `runDueJobs` only ever picks up `execute`, and a job created and left in
  // `intake` would sit there forever. There is no planner call here (§4.3:
  // "the child never goes through the planner") — the plan is derived
  // deterministically above — but the PHASES themselves are not skipped,
  // because `LEGAL_TRANSITIONS` has no `intake → execute` and nothing
  // downstream should have to special-case a job that arrived at `execute`
  // without passing through `plan`.
  await transition(child.jobId, {
    to: 'understand',
    actor: 'orchestrator',
    reason: 'child job opened by a delegation',
    businessId,
  });
  await transition(child.jobId, {
    to: 'plan',
    actor: 'orchestrator',
    reason: 'plan derived deterministically from the envelope, not from the planner',
    businessId,
  });
  await bindPlanToJob(child.jobId, childPlan, { businessId });
  await transition(child.jobId, {
    to: 'execute',
    actor: 'orchestrator',
    reason: 'ready to run its one step',
    businessId,
  });
  await attachChildJob(envelope.id, child.jobId, { businessId });
  await transition(parent.jobId, {
    to: 'followup',
    actor: 'orchestrator',
    reason: `ממתין לתשובת ${input.to} על "${input.intent}" (מעטפת ${envelope.id})`,
    envelopeId: envelope.id,
    awaitingEnvelopeId: envelope.id,
    businessId,
  });

  // 5. Audit, after the commit — never the payload, never what the context
  // refs point at (see the docblock on `AuditKind`'s `'delegation'` member).
  try {
    await appendAudit(
      {
        jobId: parent.jobId,
        envelopeId: envelope.id,
        actor: 'orchestrator',
        kind: 'delegation',
        charterVersion: constraints.charterVersion,
        provenance: constraints.provenanceCeiling,
        inputHash: canonicalHash({ from: input.from, to: input.to, intent: input.intent }),
        reason:
          `${input.from} ביקש עזרה מ-${input.to} ("${input.intent}"), ` +
          `קפיצה ${envelope.hops}, מעטפת ${envelope.id}`,
      },
      { businessId },
    );
  } catch (error) {
    throw new DelegationAuditUnrecordedError(
      { envelopeId: envelope.id, childJobId: child.jobId, parentJobId: parent.jobId },
      error,
    );
  }

  return { status: 'opened', envelopeId: envelope.id, childJobId: child.jobId };
}
