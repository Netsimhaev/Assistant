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
 * transaction and `FOR UPDATE` lock unchanged).
 *
 * **The order is: envelope, child, plan bound, ATTACH, then the child moves
 * to `execute`, then the parent is parked — and `attachChildJob` before the
 * move to `execute` is load-bearing, not incidental.** `runDueJobs` picks up
 * anything sitting in `execute` with a bound plan; it does not check whether
 * an envelope points at it. Attaching after would leave a window where the
 * child is runnable and unattached — the scheduler could run it and it would
 * answer into a void no envelope names, and whatever reads the envelope back
 * to find the parent to wake (`resumeDelegatedJobs`, in
 * `orchestrator/resume-delegated.ts`, run on every `schedulerPass`)
 * would have nothing pointing the other way. Attaching first at least means
 * the only reachable crash window leaves a child that is attached but not yet
 * runnable, which a future deadline check has something to find.
 *
 * A crash after `writeEnvelope` commits but before the child is created still
 * leaves a durable, idempotent trace: a retry with the same inputs hits the
 * same idempotency key and is told `duplicate` rather than opening a second
 * child. That branch also reports the envelope's stored `child_job_id` (`null`
 * if this is exactly that crash window, a real id once one was attached), so
 * a caller that sees `null` there knows it is looking at an orphan rather than
 * a completed delegation — the repair `attachChildJob` exists to make, once
 * the caller has re-derived the child id some other way. This is the same
 * physical limit `recordStepCompletion` already documents for a crash between
 * an adapter call and its completion row — at-least-once, not exactly-once,
 * and the honest thing to do is name the window rather than pretend a single
 * function call can make it disappear.
 */
import { ulid } from 'ulid';
import { config } from '../config.js';
import { AgentId } from '../domain/audit.js';
import type { AgentEnvelope, ContextRef, EnvelopeConstraints } from '../domain/envelope.js';
import type { Plan } from '../domain/plan.js';
import type { PolicyBundle } from '../domain/policy.js';
import { classifyAction } from '../policy/classify.js';
import { appendAudit } from '../audit/log.js';
import {
  contextRefsHash,
  dailyCapGuard,
  hopGuard,
  mayDelegate,
  noNewInformationGuard,
  oscillationGuard,
  tightenConstraints,
  type DelegationDenial,
} from '../governance/delegation.js';
import {
  attachChildJob,
  countPairExchanges,
  delegationsToday,
  loadEnvelopeByIdempotencyKey,
  loadEnvelopeForChildJob,
  loadEnvelopeWithChild,
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
   *
   * **Both values are verified against the rows, including `null`.** A supplied
   * envelope must be the one `agent_envelopes` agrees opened this parent
   * (`parent_envelope_mismatch`); `null` must be true — a parent for which no
   * envelope names it as `child_job_id` (`parent_envelope_omitted`). Verifying
   * only the first left the loosest claim as the only unchecked one.
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
  | 'ambiguous_context_ref'
  | 'parent_envelope_mismatch'
  | 'parent_envelope_omitted'
  | DelegationDenial['code'];

export type RequestHelpResult =
  | { status: 'opened'; envelopeId: string; childJobId: string }
  /**
   * The same request was already made — no second child was opened.
   * `childJobId` is `null` when the earlier attempt crashed before attaching
   * one (see this module's docblock); a caller that sees `null` here is
   * looking at an orphan and can repair it with `attachChildJob` directly,
   * once it has re-derived the child id some other way — `requestHelp` itself
   * has no way to hand back an id nobody ever recorded.
   *
   * `correlationId` rides along so a caller can look up the `result`
   * envelope `resumeDelegatedJobs` may already have written for this
   * delegation (`loadResultForChildJob`) without a second query to re-derive
   * it from the envelope — it is already on hand here, from the very row
   * that answered this lookup.
   */
  | { status: 'duplicate'; envelopeId: string; childJobId: string | null; correlationId: string }
  | { status: 'refused'; code: RequestHelpDenialCode; reason: string };

/**
 * The three ids identifying a delegation that has already taken effect — what
 * `DelegationAuditUnrecordedError` carries so an operator can reconstruct the
 * audit row by hand.
 *
 * NOT `DelegationOutcome` (`domain/envelope.ts`), which it was called until
 * this branch's final review: that is the closed enum
 * `'succeeded' | 'failed' | 'timeout'` a `result` envelope's payload carries,
 * and two unrelated exported symbols under one name in one subsystem is how a
 * reader ends up importing the wrong one.
 */
export interface RequestHelpOutcome {
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
  readonly outcome: RequestHelpOutcome;

  constructor(outcome: RequestHelpOutcome, cause: unknown) {
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

  // 1.5. Layer two of §6.3's graph check, duplicated here on purpose.
  // `evaluateToolCall`'s own `agent.request_help` branch already checks
  // `mayDelegate`, but only for a call that arrives as a gated plan step —
  // `requestHelp` is also called directly (Task 10), and that path never
  // passes through the gate at all. `ops.web`'s empty graph entry is the one
  // rule the capability tests say must never be relaxed, and a lone check in
  // `engine.ts` would leave this, the actual choke point that opens a child,
  // with none. Parsed rather than trusted from the type: `input.from` is
  // `AgentId`-typed at compile time, but a caller across a process boundary
  // (or a future one that stops being careful) is not bound by that.
  //
  // Deliberately still ABOVE guard 3 (idempotency), even after round 2 moved
  // guard 3 above every OTHER guard this function owns: a signed charter
  // amendment that drops this exact edge between the original call and a
  // resumed retry will fail the parent here, with the child's answer already
  // sitting written and unread. That is correct, not an oversight — a signed
  // amendment revoking a permission should stop work in flight, and failing
  // the parent is the honest consequence of the owner having revoked the
  // very permission that produced the answer.
  const fromAgent = AgentId.safeParse(input.from);
  if (!fromAgent.success || !mayDelegate(input.bundle.collaborationGraph, fromAgent.data, input.to)) {
    return {
      status: 'refused',
      code: 'not_permitted',
      reason: `${input.from} אינו רשאי לבקש עזרה מ-${input.to}`,
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
  // Every ref matching the required kind, not just the first — two matches at
  // the same level are a refusal, never the first one in the array. The
  // house rule (`resolveChannel`): "שתי התאמות באותה רמה הן דחייה ולא הראשונה
  // במערך". A silent first-wins here would let the envelope's own record
  // (both pointers, both folded into the guard-4 hash) disagree with the one
  // pointer `buildStepInput` actually hands the child.
  const matchingRefs =
    spec.requiresContextRef === null
      ? []
      : input.contextRefs.filter((ref) => ref.kind === spec.requiresContextRef);
  if (spec.requiresContextRef !== null && matchingRefs.length === 0) {
    return {
      status: 'refused',
      code: 'missing_context_ref',
      reason: `הכוונה "${input.intent}" דורשת מצביע מסוג ${spec.requiresContextRef} וכזה לא סופק`,
    };
  }
  if (matchingRefs.length > 1) {
    return {
      status: 'refused',
      code: 'ambiguous_context_ref',
      reason: `הכוונה "${input.intent}" קיבלה יותר ממצביע אחד מסוג ${spec.requiresContextRef ?? ''}`,
    };
  }
  const matchingRef = matchingRefs[0] ?? null;

  // The caller's claim about its own ancestry is verified against the row,
  // not trusted — and every value used below comes from the LOADED row, never
  // from `input.parentEnvelope` itself. `input.parentEnvelope` supplies only
  // an id to look up; a caller holding a legitimately-attached envelope id
  // could otherwise still pass `hops: 0` to slip `hopGuard`, a different
  // `correlationId` to escape both anti-ping-pong guards' scope (they are
  // scoped by it), or a loosened `constraints` object to widen the child's
  // ceiling — the object itself proves nothing, and re-reading its fields
  // after the check would defeat the check. `parentEnvelope: null` is the
  // easiest legal value to pass by accident (it resets hops to 0, opens a
  // fresh correlation, and hands back the maximally permissive root ceiling),
  // so a fabricated or stale envelope here is a real way to widen a child's
  // authority. The same correction `grantAuthorization` already applies to a
  // job's claimed provenance and `GateContext.standing` applies to a claimed
  // authorisation.
  let verifiedAncestor: AgentEnvelope | null = null;
  if (input.parentEnvelope !== null) {
    const stored = await loadEnvelopeWithChild(input.parentEnvelope.id, { businessId });
    if (stored === null || stored.childJobId !== parent.jobId) {
      return {
        status: 'refused',
        code: 'parent_envelope_mismatch',
        reason:
          `המעטפת ${input.parentEnvelope.id} שסופקה כמעטפת ההורה אינה מצביעה ` +
          `על המשימה ${parent.jobId} כבת שלה`,
      };
    }
    verifiedAncestor = stored.envelope;
  } else {
    // `parentEnvelope: null` is a CLAIM — "this parent is a root job" — and it
    // is the most permissive claim this input can make: it resets `hops` to 0,
    // opens a fresh `correlationId` (taking `noNewInformationGuard` and
    // `oscillationGuard`, both scoped by it, out of the real tree), and hands
    // back `ROOT_ANCESTOR_CONSTRAINTS`. The non-null branch above verifies its
    // claim against the row; leaving the null branch unverified meant the
    // EASIEST value to pass was the only one nothing checked. Verified the same
    // way, and positively: a root job is one for which `agent_envelopes` holds
    // NO row naming it as `child_job_id`. Not reachable from attacker-shaped
    // input today — all three callers either derive the envelope
    // (`local-tools.ts`, via `loadEnvelopeForChildJob` on the same key) or
    // create the parent job two statements earlier (`conduct.ts`) — so this
    // closes a latent hole structurally rather than a live one, the same
    // posture `grantAuthorization` takes towards a claimed provenance.
    //
    // Placed in this branch, beside the check it mirrors, and therefore still
    // ABOVE guard 3 (idempotency): it reads no time-varying counter, so unlike
    // `dailyCapGuard` its answer cannot differ between the call that opened a
    // delegation and the call retrying it.
    const governing = await loadEnvelopeForChildJob(parent.jobId, { businessId });
    if (governing !== null) {
      return {
        status: 'refused',
        code: 'parent_envelope_omitted',
        reason:
          `המשימה ${parent.jobId} נפתחה כמשימת-בת של המעטפת ${governing.id} ואינה משימת שורש, ` +
          `ולכן בקשת עזרה ממנה חייבת למסור את המעטפת הזו ולא null`,
      };
    }
  }

  // Ancestry: inherited from the VERIFIED ancestor when there is one,
  // otherwise this is the root of a new tree.
  const parentHops = verifiedAncestor?.hops ?? 0;
  const correlationId = verifiedAncestor?.correlationId ?? parent.jobId;
  const causalChain = verifiedAncestor
    ? [...verifiedAncestor.causalChain, verifiedAncestor.id]
    : [];
  const ancestorConstraints: EnvelopeConstraints =
    verifiedAncestor?.constraints ?? {
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

  // 3. The guards this function owns — and guard 3 (idempotency) runs FIRST,
  // before hop, cap, no-new-information and oscillation alike. Round 1 of
  // this task's review put it ahead of guard 4 only, and that was not
  // enough: `dailyCapGuard` reads `delegationsToday()`, a SHARED,
  // TIME-VARYING counter, so its answer can differ between the call that
  // opened this exact delegation and the resumed call retrying it — an
  // installation that reaches its daily cap between the two would fail
  // every parked parent resuming that day with `daily_cap`, even though each
  // one is asking nothing new. `hopGuard` has no such hazard (`parentHops` is
  // derived identically both times), but there is no reason to trust that of
  // every future guard added here, and "the answer to an already-answered
  // question never depends on today's counters" is the simpler invariant to
  // hold. A repeat of an already-answered request is checked and answered
  // before ANY of this function's own guards run.
  //
  // `parentJobId` is part of the key — not just
  // `(correlationId, from, to, intent, contextRefsHash, payload)` — because
  // two DIFFERENT parent jobs in the same correlation can legitimately issue
  // the byte-identical request (a sibling asking the same thing `from` the
  // same agent `to` the same agent about the same context). Without
  // `parentJobId`, the second one would silently resolve to the FIRST one's
  // envelope and child — reporting `duplicate`/`answered` for a delegation it
  // never opened, with no envelope of its own. Adding it also restores the
  // division between this guard and guard 4 that the reordering blurred:
  // guard 3 now answers "is THIS JOB retrying its own prior request", and
  // guard 4 (`noNewInformationGuard`, unchanged — it stays keyed without
  // `parentJobId`) answers "has ANYONE in this tree already asked this".
  const refsHash = contextRefsHash(input.contextRefs);
  const idempotencyKey = canonicalHash({
    parentJobId: parent.jobId,
    correlationId,
    from: input.from,
    to: input.to,
    intent: input.intent,
    contextRefsHash: refsHash,
    payload: parsedPayload.data,
  });
  const alreadyAnswered = await loadEnvelopeByIdempotencyKey(idempotencyKey, { businessId });
  if (alreadyAnswered !== null) {
    return {
      status: 'duplicate',
      envelopeId: alreadyAnswered.envelope.id,
      childJobId: alreadyAnswered.childJobId,
      correlationId: alreadyAnswered.envelope.correlationId,
    };
  }

  const hopDenial = hopGuard(parentHops);
  if (hopDenial !== null) return { status: 'refused', ...hopDenial };

  const usedToday = await delegationsToday({ businessId });
  const capDenial = dailyCapGuard(usedToday, config.delegationsPerDay);
  if (capDenial !== null) return { status: 'refused', ...capDenial };

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
    // Computed once, above, and reused here — it is also the value guard 3
    // just looked up and found nothing under.
    idempotencyKey,
    createdAt: now.toISOString(),
  };

  const written = await writeEnvelope(envelope, { parentJobId: parent.jobId, businessId });
  if (written.status === 'duplicate') {
    return {
      status: 'duplicate',
      envelopeId: written.envelope.id,
      childJobId: written.childJobId,
      correlationId: written.envelope.correlationId,
    };
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
  //
  // **`attachChildJob` runs BEFORE the move to `execute`, and this order is
  // load-bearing.** `runDueJobs` picks up anything sitting in `execute` with a
  // bound plan — it does not check whether an envelope points at it. A crash
  // in the old order (execute, then attach) left a window where the child was
  // already runnable and unattached: the scheduler could run it and it would
  // answer into a void no envelope named, and whatever eventually wakes the
  // parent (`resumeDelegatedJobs`, which starts from the parent's
  // `awaiting_envelope_id` and reaches the child through the envelope's
  // `child_job_id`) would have no envelope pointing at this child to find.
  // Attaching first at least means the only reachable crash window leaves a
  // child that is attached but not yet runnable, which the deadline branch of
  // `resumeDelegatedJobs` has something to find.
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
  await attachChildJob(envelope.id, child.jobId, { businessId });
  await transition(child.jobId, {
    to: 'execute',
    actor: 'orchestrator',
    reason: 'ready to run its one step',
    businessId,
  });
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
