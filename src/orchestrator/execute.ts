import type { AgentId } from '../domain/audit.js';
import type { PolicyBundle } from '../domain/policy.js';
import { MONETARY_CLASSES } from '../domain/action.js';
import { classifyAction, refineActionClass } from '../policy/classify.js';
import { evaluateToolCall } from '../policy/engine.js';
import { recordSpend } from '../policy/budget.js';
import { canonicalHash } from '../util/canonical.js';
import { transition } from './jobs.js';
import type { Job } from './jobs.js';

export interface StepRequest {
  job: Job;
  stepId: string;
  agent: AgentId;
  bundle: PolicyBundle;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Performs the actual side effect once the gate has permitted it. */
  perform: (redactedInput: unknown) => Promise<unknown>;
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
 */
export async function executeStep(request: StepRequest): Promise<StepOutcome> {
  const { job, bundle, toolName, toolInput } = request;
  const now = request.now ?? new Date();

  const decision = await evaluateToolCall(toolName, toolInput, {
    agent: request.agent,
    bundle,
    provenance: job.provenance,
    chainDepth: 0,
    businessId: job.businessId,
    jobId: job.jobId,
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
  const result = await request.perform(decision.redactedInput);

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
  if (!MONETARY_CLASSES.has(actionClass)) return false;

  const amountMinor = request.toolInput['amountMinor'];
  if (typeof amountMinor !== 'number' || amountMinor <= 0) return false;

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
