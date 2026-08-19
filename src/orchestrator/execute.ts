import type { AgentId } from '../domain/audit.js';
import type { PolicyBundle } from '../domain/policy.js';
import { isMoneyBearing } from '../domain/action.js';
import type { AutonomyLevel } from '../domain/trust.js';
import { classifyAction, refineActionClass } from '../policy/classify.js';
import { evaluateToolCall } from '../policy/engine.js';
import { recordSpend } from '../policy/budget.js';
import { canonicalHash } from '../util/canonical.js';
import { transition } from './jobs.js';
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

export interface StepRequest {
  job: Job;
  stepId: string;
  agent: AgentId;
  bundle: PolicyBundle;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Performs the actual side effect once the gate has permitted it. */
  perform: (redactedInput: unknown) => Promise<unknown>;
  /** Tags of the resolved counterparty; `[]` when nothing resolved them. */
  counterpartyTags: string[];
  /** Earned autonomy from the ramp; `draft_only` until a ramp exists. */
  rampLevel: AutonomyLevel;
  now?: Date;
}

export type StepOutcome =
  | { status: 'done'; result: unknown; spendRecorded: boolean }
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
 * **A `deferred` outcome is not a bookmark.** Quiet hours and a retryable
 * channel failure both move the job to `followup` with a `wakeAt`, and the
 * scheduler later returns it to `execute` — but nothing here records which
 * step was in flight, and no plan state is persisted anywhere. Whatever calls
 * back in is starting over. `AdapterCall.idempotencyKey` is the only thing
 * standing between a re-run and a duplicate at the far end, and it protects
 * only against systems that honour such a key.
 *
 * Persisting step progress so a woken job resumes where it stopped is future
 * work, stated here so a `deferred` return is not mistaken for one.
 */
export async function executeStep(request: StepRequest): Promise<StepOutcome> {
  const { job, bundle, toolName, toolInput } = request;
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

  const decision = await evaluateToolCall(toolName, toolInput, {
    agent: request.agent,
    bundle,
    provenance: job.provenance,
    chainDepth: 0,
    businessId: job.businessId,
    jobId: job.jobId,
    counterpartyTags: request.counterpartyTags,
    rampLevel: request.rampLevel,
    now,
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
  let result: unknown;
  try {
    result = await request.perform(decision.redactedInput);
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
      await transition(job.jobId, {
        to: 'followup',
        actor: 'orchestrator',
        reason: `${code} — retry:${request.stepId} at ${wakeAt.toISOString()}`,
        wakeAt,
        businessId: job.businessId,
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

  const spendRecorded = await recordStepSpend(request);

  await transition(job.jobId, {
    to: 'verify',
    actor: request.agent,
    reason: `${request.stepId} · ${toolName}`,
    businessId: job.businessId,
  });

  return { status: 'done', result, spendRecorded };
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
async function recordStepSpend(request: StepRequest): Promise<boolean> {
  const base = classifyAction(request.toolName);
  if (base === null) return false;

  const actionClass = refineActionClass(base, request.toolInput);

  const amountMinor = request.toolInput['amountMinor'];
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
        input: request.toolInput,
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
