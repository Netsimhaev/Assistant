import type { AgentId } from '../domain/audit.js';
import type { PolicyBundle } from '../domain/policy.js';
import { isMoneyBearing } from '../domain/action.js';
import type { AutonomyLevel } from '../domain/trust.js';
import { classifyAction, ingestsExternalContent, refineActionClass } from '../policy/classify.js';
import { evaluateToolCall } from '../policy/engine.js';
import { getApproval } from '../governance/approvals.js';
import type { ApprovalNotifier } from '../governance/notify.js';
import { recordSpend } from '../policy/budget.js';
import { canonicalHash } from '../util/canonical.js';
import { markContentIngested, transition } from './jobs.js';
import { StepChannelError } from './step-error.js';
import type { Job } from './jobs.js';

/**
 * How long a step sleeps before a retryable channel failure is tried again.
 *
 * Flat, and no attempt counter: a permanently unreachable server therefore
 * retries forever. Exponential backoff and attempt counting belong with the
 * retry policy as a whole, and are tracked as follow-up work rather than
 * half-built here.
 */
const RETRY_DELAY_MS = 5 * 60 * 1000;

/**
 * What one step produced: whatever the adapter returned, and the provider's
 * handle on what it created.
 *
 * `externalId` is part of the contract rather than something the caller keeps
 * on the side, because this function is what records the step as complete and
 * the handle has to be written down with it — `verify` has no other way to ask
 * the far end what actually happened after a resume.
 */
export interface StepEffect {
  output: unknown;
  externalId: string | null;
}

export interface StepRequest {
  job: Job;
  stepId: string;
  agent: AgentId;
  bundle: PolicyBundle;
  toolName: string;
  toolInput: Record<string, unknown>;
  /**
   * Performs the actual side effect once the gate has permitted it.
   *
   * Takes two payloads, and the difference matters. `redactedInput` is what
   * goes on the wire — the charter's patterns already applied — and is the
   * only thing an adapter ever sees. `effectiveInput` is the same action
   * *before* redaction, and is what the performer must use to choose a
   * destination: which signed connection, which endpoint, which credential,
   * and the idempotency key. On an approval-with-edit those two differ from
   * the originally proposed step, and routing by the proposal while the gate
   * judged the edit is how a corrected supplier gets its ceiling enforced and
   * its order sent to the supplier it replaced.
   *
   * Routing off `redactedInput` would be the wrong shortcut: a redaction
   * pattern that happens to match an id would blank the very field the route
   * is chosen by.
   */
  perform: (redactedInput: unknown, effectiveInput: Record<string, unknown>) => Promise<StepEffect>;
  /** Tags of the resolved counterparty; `[]` when nothing resolved them. */
  counterpartyTags: string[];
  /** Earned autonomy from the ramp; `draft_only` until a ramp exists. */
  rampLevel: AutonomyLevel;
  /**
   * The plan this step belongs to, when it belongs to one.
   *
   * Present, the step's completion is written down and a later run of the same
   * plan skips it. Absent — a caller running a single step outside any stored
   * plan — nothing is recorded, because there is no plan for a resume to walk.
   */
  planHash?: string;
  now?: Date;
  /**
   * The approval this step is resuming under, when it is resuming under one.
   *
   * The executor, not the gate, is what knows a run came back from a human
   * decision — the gate sees one tool call and has no memory of the job's
   * history.
   */
  approvalId?: string;
  /**
   * How to tell the owner an approval is waiting.
   *
   * Optional because the gate treats notification as best-effort — the request
   * row and the dashboard exist either way, and `evaluateToolCall` records
   * `approval_notify_failed` rather than throwing. Absent, an approval is
   * queued and nobody is told, which is exactly the state this field exists to
   * end.
   */
  notify?: { notifier: ApprovalNotifier; dashboardBaseUrl: string };
  /**
   * The caller's claim that this step's content chain is boss-derived —
   * forwarded verbatim into `GateContext.provenanceChainDerived`.
   *
   * The executor does not compute this; `runPlan` does, because it is the
   * only party holding both the plan (to check no earlier step ingests) and
   * the job (to check its stamp and its history). See
   * `ActionFacts.provenanceChainDerived` for the three conditions.
   */
  provenanceChainDerived?: boolean;
}

export type StepOutcome =
  | { status: 'done'; result: unknown; spendRecorded: boolean; externalId: string | null }
  | { status: 'awaiting_approval'; approvalId: string }
  | { status: 'deferred'; code: string; wakeAt: string }
  | { status: 'refused'; code: string; reason: string };

/**
 * Run one plan step: gate, then act, then account for it.
 *
 * The order is the whole point. Nothing performs a side effect that has not
 * passed `evaluateToolCall` first, and nothing that spent money returns without
 * the spend being written to the ledger.
 *
 * **A `deferred` outcome is now a bookmark, for the steps before it.** Quiet
 * hours and a retryable channel failure both move the job to `followup` with a
 * `wakeAt`, and the scheduler later returns it to `execute`. A step that
 * finished under a `planHash` has its completion written down — in the same
 * transaction as the move to `verify` — so the run that comes back skips it
 * instead of doing it again. The deferred step itself recorded nothing,
 * correctly: it did not happen.
 *
 * **`awaiting_approval` IS a bookmark now, the same as `deferred`.** A caller
 * resuming a step passes back `request.approvalId`, and it travels into the
 * gate as `GateContext.approval` — `stepId` riding alongside it so
 * `consumed_by_step` names who spent it. `evaluateToolCall` then spends the
 * approval itself (TOCTOU hash check included) instead of recomputing
 * `needsApproval` and enqueueing a second request. A spent approval stays
 * spent even if the step goes on to fail: the claim is a single conditional
 * UPDATE with nothing to undo it, so a retry after a failed `perform` queues a
 * *fresh* approval request rather than trying to reuse the one already spent.
 *
 * On an approval-with-edit, the boss changed the action on the card and
 * `decide` re-bound the approval's hash to that edited input — so this
 * function substitutes `approval.editedInput` for `request.toolInput`
 * *before* the gate ever sees it, both for the hash check to match and so the
 * thing that runs is the thing that was actually approved.
 *
 * What that does not buy is exactly-once. A crash between the external call
 * returning and the completion committing leaves the step done and unrecorded,
 * and the resumed run repeats it; `recordStepCompletion` states the limit in
 * full. `AdapterCall.idempotencyKey` is the only thing standing between that
 * repeat and a duplicate at the far end, and it protects only against systems
 * that honour such a key.
 */
export async function executeStep(request: StepRequest): Promise<StepOutcome> {
  const { job, bundle, toolName } = request;
  const now = request.now ?? new Date();

  // The phase is checked BEFORE the side effect, not after it.
  //
  // `transition` validates the predecessor, but the only transition here used
  // to be the one to `verify` — which runs after `perform`. Re-invoking a step
  // on a halted, failed or dormant job therefore sent the mail and only then
  // threw "illegal transition". The action had happened and no job_steps row
  // recorded it.
  if (job.phase !== 'execute') {
    return {
      status: 'refused',
      code: 'job_not_executable',
      reason: `job ${job.jobId} is in phase ${job.phase}, not execute`,
    };
  }

  // What runs is what was approved. On an approval-with-edit the boss changed
  // the action on the card, `decide` re-bound the approval's hash to that
  // edited input, and running the original would both do the wrong thing and
  // fail the gate's hash check — which is exactly how this was found.
  //
  // The job check is not decoration. `getApproval` is scoped by business only,
  // and `executeStep` is exported and takes `approvalId` from whoever calls it
  // — so without this predicate an approval belonging to ANOTHER job of the
  // same business could replace this step's payload before the gate ever saw
  // it. `consumeApproval` would then return `wrong_job`, which falls through
  // to the normal path — and that path evaluates the substituted input. If it
  // classified as routine, one job's edited payload executed under another
  // job's ordinary allow, with no approval spent and nothing in the audit
  // trail saying whose text it was. The approval must belong to this job
  // before it is allowed to influence anything at all.
  let effectiveInput = request.toolInput;
  if (request.approvalId !== undefined) {
    const approval = await getApproval(request.approvalId, { businessId: job.businessId });
    if (
      approval?.jobId === job.jobId &&
      approval.state === 'approved_with_edit' &&
      approval.editedInput !== null
    ) {
      effectiveInput = approval.editedInput as Record<string, unknown>;
    }
  }

  const decision = await evaluateToolCall(toolName, effectiveInput, {
    agent: request.agent,
    bundle,
    // The job's stamp, inherited by every step. `provenanceChainDerived` below
    // is the caller's claim, not something computed here — this function sees
    // one step, not the plan or the job's ingest history. `runPlan` is what
    // checks, before setting it: the job's provenance is `boss`, the plan
    // contains no step that ingests external content, and the job has never
    // ingested any. `chainDepth` is hardcoded because nothing here derives it
    // either, and it is deliberately not used as a discriminator anywhere.
    provenance: job.provenance,
    chainDepth: 0,
    businessId: job.businessId,
    jobId: job.jobId,
    counterpartyTags: request.counterpartyTags,
    rampLevel: request.rampLevel,
    // Ask the gate to consult an instruction the owner already gave for this
    // job (C1). Before this, `instruct.ts` wrote a `job_authorizations` row on
    // every instruction and no production caller ever set this flag, so the
    // row was read by nothing and the owner was asked again about exactly
    // what they had just asked for.
    //
    // Safe by construction, which is why it can be a flat `true` rather than
    // something a caller steers. This is an opt-in to a LOOKUP, never an
    // assertion of what was authorised: `evaluateToolCall` loads the row
    // itself from `ctx.jobId` and the gate's own resolved business (see
    // `GateContext.useStandingAuthorization`), `grantAuthorization` refuses
    // to write one for any job whose `jobs.provenance` is not `boss`, and
    // `coveredByAuthorization` re-checks job, business, money, action class
    // and every recipient independently. A job the conductor opened is
    // `unknown_external`, so there is never a row for it to find — and the
    // three disjuncts of `needsApproval` mean this can only ever cancel the
    // risk-band escalation, never the charter ceiling the owner signed and
    // never `NEVER_FULLY_AUTONOMOUS`.
    useStandingAuthorization: true,
    now,
    ...(request.approvalId !== undefined
      ? { approval: { approvalId: request.approvalId, stepId: request.stepId } }
      : {}),
    ...(request.notify !== undefined ? { notify: request.notify } : {}),
    ...(request.provenanceChainDerived !== undefined
      ? { provenanceChainDerived: request.provenanceChainDerived }
      : {}),
  });

  if (decision.outcome === 'queue_approval') {
    await transition(job.jobId, {
      to: 'await_approval',
      actor: 'orchestrator',
      reason: decision.code,
      businessId: job.businessId,
    });
    return { status: 'awaiting_approval', approvalId: decision.approvalId };
  }

  if (decision.outcome === 'deny') {
    // Quiet hours is the one denial that is not a refusal. The action is
    // permitted, it is simply too early — so the job sleeps until the window
    // closes instead of failing and losing the work.
    if (decision.code === 'quiet_hours' && bundle.quietHours !== null) {
      const wakeAt = nextTimeAt(bundle.quietHours.to, bundle.quietHours.timezone, now);
      await transition(job.jobId, {
        to: 'followup',
        actor: 'orchestrator',
        reason: `${decision.code} — נדחה ל-${wakeAt.toISOString()}`,
        wakeAt,
        businessId: job.businessId,
      });
      return { status: 'deferred', code: decision.code, wakeAt: wakeAt.toISOString() };
    }

    await transition(job.jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: `${decision.code} — ${decision.reason}`,
      businessId: job.businessId,
    });
    return { status: 'refused', code: decision.code, reason: decision.reason };
  }

  // Permitted. The redacted input is what actually goes out — the caller is
  // handed it rather than the original so a step cannot accidentally send the
  // unredacted payload it proposed.
  //
  // A failure here must not fall through to the accounting and the `verify`
  // transition below. It used to: `perform`'s result was ignored entirely, so
  // an adapter reporting `browser_not_implemented` was recorded as an order
  // placed and followed by a confirmation email. `perform` now throws on any
  // non-ok adapter result, and this is where that becomes an outcome.
  //
  // Recorded before the call, not after. A crash between the external call
  // returning and this write landing would otherwise leave a step that read
  // outside content with no memory of having done so — the one direction that
  // hands out an exemption nobody earned. Marking early can only
  // over-restrict a later step, which is the safe direction.
  //
  // The match count `markContentIngested` returns is ignored here on purpose:
  // `job` above was loaded from the very row this UPDATE targets, so a
  // zero-row match cannot happen the way it can for the SDK gate hook, which
  // takes `jobId` and `businessId` as independent caller-supplied fields and
  // checks the count for exactly that reason.
  if (ingestsExternalContent(toolName)) {
    await markContentIngested(job.jobId, { businessId: job.businessId });
  }

  let effect: StepEffect;
  try {
    effect = await request.perform(decision.redactedInput, effectiveInput);
  } catch (error) {
    // An adapter that throws must not escape past the outcome record: the
    // intent is already in the audit log and would otherwise have no ending.
    const code = error instanceof StepChannelError ? error.code : 'adapter_threw';
    const retryable = error instanceof StepChannelError && error.retryable;
    const message = error instanceof Error ? error.message : String(error);

    if (retryable) {
      // The far end being down is a reason to come back later, and the
      // scheduler already runs that loop.
      const wakeAt = new Date(now.getTime() + RETRY_DELAY_MS);

      // A dispatched call that never answered leaves a row saying so, in this
      // same transaction.
      //
      // Every other retryable failure carries the adapter's own claim that
      // nothing was created, so a missing row honestly means "nothing
      // happened". `adapter_timeout` carries no such claim — the call may or
      // may not have landed — and a missing row there reads as "nothing ran",
      // which is what licenses `bindPlanToJob` to replace the plan. A re-plan
      // changes the step id or the input and therefore the idempotency key, so
      // the far end cannot deduplicate and the order is placed a second time,
      // for real. The row is `unknown`, not `completed`: a resume of the SAME
      // plan still re-runs this step, under the identical key, which is the
      // behaviour the timeout path is designed for.
      const unknownOutcome =
        error instanceof StepChannelError && error.outcomeUnknown;

      await transition(job.jobId, {
        to: 'followup',
        actor: 'orchestrator',
        reason: `${code} — retry:${request.stepId} at ${wakeAt.toISOString()}`,
        wakeAt,
        businessId: job.businessId,
        ...(unknownOutcome && request.planHash !== undefined
          ? {
              completedStep: {
                stepId: request.stepId,
                planHash: request.planHash,
                externalId: null,
                status: 'unknown' as const,
              },
            }
          : {}),
      });
      return { status: 'deferred', code, wakeAt: wakeAt.toISOString() };
    }

    await transition(job.jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: `${code} — ${message}`,
      businessId: job.businessId,
    });
    return { status: 'refused', code, reason: message };
  }

  const spendRecorded = await recordStepSpend(request, effectiveInput);

  // The completion rides inside this transition's transaction. Recording it
  // afterwards would leave a window where the job has moved on and the step it
  // moved past is unrecorded — which a resume reads as work still to do.
  await transition(job.jobId, {
    to: 'verify',
    actor: request.agent,
    reason: `${request.stepId} · ${toolName}`,
    businessId: job.businessId,
    ...(request.planHash === undefined
      ? {}
      : {
          completedStep: {
            stepId: request.stepId,
            planHash: request.planHash,
            externalId: effect.externalId,
            status: 'completed' as const,
          },
        }),
  });

  return {
    status: 'done',
    result: effect.output,
    spendRecorded,
    externalId: effect.externalId,
  };
}

/**
 * Write committed spend to the ledger.
 *
 * `recordSpend` had no caller, so `spend_ledger` was always empty — which meant
 * the daily and monthly ceilings summed to zero and never held. The signed
 * sentence "this is your maximum daily exposure" was, until now, not enforced
 * by anything.
 *
 * The idempotency key is (jobId, stepId, canonical input hash), so a retry
 * after an uncertain timeout cannot count the same purchase twice.
 */
async function recordStepSpend(
  request: StepRequest,
  effectiveInput: Record<string, unknown>,
): Promise<boolean> {
  const base = classifyAction(request.toolName);
  if (base === null) return false;

  const actionClass = refineActionClass(base, effectiveInput);

  const amountMinor = effectiveInput['amountMinor'];
  if (typeof amountMinor !== 'number' || amountMinor <= 0) return false;

  // One predicate for both halves of the accounting. The ledger used to record
  // only six classes while `checkBudget` charged *any* action carrying an
  // amount against the daily ceiling — so a class outside that set could be
  // charged against a ceiling it never contributed to, and repeated calls each
  // passed the per-action cap while the daily total stayed at zero.
  if (!isMoneyBearing(actionClass, amountMinor)) return false;

  return recordSpend(
    {
      jobId: request.job.jobId,
      actionClass,
      amountMinor,
      currency: request.bundle.ceilings.currency,
      idempotencyKey: canonicalHash({
        jobId: request.job.jobId,
        stepId: request.stepId,
        input: effectiveInput,
      }),
    },
    { businessId: request.job.businessId },
  );
}

/**
 * The next moment at `hh:mm` in `timezone` that is strictly after `from`.
 *
 * Computed by probing forward in minute-resolution steps rather than by
 * constructing a local date: constructing one requires knowing the zone's UTC
 * offset *at that future instant*, which is exactly what DST makes unsafe to
 * assume. Probing asks Intl, which knows.
 */
function nextTimeAt(hhmm: string, timezone: string, from: Date): Date {
  const target = parseHhMm(hhmm);
  if (target === null) return new Date(from.getTime() + 60 * 60 * 1000);

  // A whole day of minutes is 1440 probes at worst; this runs once per deferred
  // step, not per request.
  for (let minutes = 1; minutes <= 60 * 24 + 60; minutes += 1) {
    const candidate = new Date(from.getTime() + minutes * 60 * 1000);
    if (localMinutes(candidate, timezone) === target) return candidate;
  }
  return new Date(from.getTime() + 60 * 60 * 1000);
}

function parseHhMm(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function localMinutes(at: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
    return (
      Number(parts.find((p) => p.type === 'hour')?.value ?? '0') * 60 +
      Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
    );
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
}
