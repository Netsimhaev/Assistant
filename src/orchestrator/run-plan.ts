import type { ActionClass } from '../domain/action.js';
import type { ConnectionBinding } from '../domain/connection.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { AutonomyLevel } from '../domain/trust.js';
import { planProblems, topologicalOrder, type Plan, type PlanStep } from '../domain/plan.js';
import { classifyAction, isOutbound, refineActionClass } from '../policy/classify.js';
import { canonicalHash } from '../util/canonical.js';
import type { AdapterRegistry } from './adapters/registry.js';
import type { AdapterResult, ExternalAdapter } from './adapters/types.js';
import { loadBindings } from './bindings.js';
import { deriveTargetId, resolveChannel } from './channels.js';
import type { CredentialSource } from './credentials.js';
import { executeStep, type StepEffect, type StepOutcome } from './execute.js';
import { loadJob, transition } from './jobs.js';
import { bindPlanToJob, completedSteps } from './plan-store.js';
import { planStepIsFeasible } from './catalogue.js';
import { StepChannelError } from './step-error.js';
import type { Job } from './jobs.js';

/**
 * How long one external call may take before it is abandoned.
 *
 * A step that never returns holds the whole plan — and the job's phase —
 * open indefinitely, which is worse than a failure the scheduler can retry.
 *
 * Enforced by racing the adapter, not only by handing it an `AbortSignal`.
 * The signal is advisory: an adapter or a transport that never checks it —
 * or a socket that ignores it — leaves the promise pending forever, and a
 * timeout nobody enforces is a comment. Both are passed: the signal so a
 * well-behaved adapter can stop its own work and release the connection,
 * the race so a badly-behaved one cannot hold the job.
 */
const ADAPTER_TIMEOUT_MS = 60_000;

export interface RunPlanRequest {
  job: Job;
  bundle: PolicyBundle;
  plan: Plan;
  /**
   * Which adapter implements which system.
   *
   * Injected rather than reached for globally, so a test drives a recording
   * adapter and no test ever sends a real message.
   */
  registry: AdapterRegistry;
  /** Whether each connection the charter permits currently works. */
  bindings: readonly ConnectionBinding[];
  /** Turns a binding's `credentialRef` into an actual secret. */
  credentials: CredentialSource;
  counterpartyTags: string[];
  rampLevel: AutonomyLevel;
  now?: Date;
  /**
   * Overrides `ADAPTER_TIMEOUT_MS` for one run.
   *
   * Exists so a test can prove the deadline is enforced without waiting a
   * minute for it. Production callers leave it unset and get the constant.
   */
  adapterTimeoutMs?: number;
}

export interface StepRecord {
  stepId: string;
  outcome: StepOutcome;
  /**
   * The provider's handle on whatever this step created — a message id, an
   * order number — or `null` when the step created nothing, ran locally, or
   * did not reach an adapter at all.
   *
   * Kept because `verify` has no other way to ask the far end what actually
   * happened: without it the adapter's own answer to "what did you create"
   * was read and dropped on the floor. It survives a deferral: a step skipped
   * on resume reports the handle the run that actually did the work returned.
   */
  externalId: string | null;
  /**
   * True when an earlier run of this same plan already completed this step and
   * this run did not re-run it.
   *
   * Reported rather than hidden: "the mail went out just now" and "the mail
   * went out yesterday and we did not send it again" are different facts, and
   * a caller deciding what to tell the owner needs to tell them apart.
   */
  skipped: boolean;
}

export type RunPlanResult =
  | { status: 'rejected'; code: string; reason: string }
  | { status: 'done'; steps: StepRecord[] }
  | { status: 'halted'; steps: StepRecord[]; at: string; reason: string };

/**
 * Execute a plan, in dependency order, one step at a time.
 *
 * Sequential on purpose. The DAG says which steps *could* run together, but
 * running them together means two gate decisions racing on the same budget and
 * two audit entries racing for the same chain tail — and the audit chain
 * serialises anyway. Concurrency here would buy latency the system does not
 * need and cost determinism it cannot spare.
 *
 * The plan is validated whole before anything runs. A step naming a tool its
 * agent does not own would fail at that step, leaving the ones before it
 * already done; rejecting the plan is the cheaper failure by far.
 *
 * **A halted plan resumes where it stopped.** Whatever ends the run — an
 * approval to wait for, quiet hours, a retryable channel failure — the job's
 * phase is moved and this function returns; the steps that had already
 * finished are on record, each written in the same transaction as the phase
 * change that followed it. A job the scheduler wakes and hands back here runs
 * the same plan again, skips those steps, and picks up at the one that
 * stopped. A skipped step is still reported, marked `skipped`.
 *
 * The plan is bound to the job on the first run and cannot change afterwards.
 * A second run offering a different plan is rejected with
 * `plan_changed_mid_flight` and nothing executes: completed steps belong to
 * the plan that produced them, and there is no correct automatic way to carry
 * them onto a re-plan — least of all by matching step ids, which two unrelated
 * plans may well share.
 *
 * Resumption is at-least-once. A crash between an adapter returning and the
 * completion committing leaves the step done and unrecorded, and the resumed
 * run does it again; `recordStepCompletion` (`plan-store.ts`) states that
 * limit and why no transaction can remove it. `AdapterCall.idempotencyKey` is
 * the only defence past that point, and only for a far end that honours it.
 */
export async function runPlan(request: RunPlanRequest): Promise<RunPlanResult> {
  const { job, bundle, plan } = request;

  const problems = planProblems(plan);
  if (problems.length > 0) {
    return { status: 'rejected', code: 'malformed_plan', reason: describe(problems[0]!) };
  }

  for (const step of plan.steps) {
    if (!planStepIsFeasible(step.agent, step.toolName)) {
      return {
        status: 'rejected',
        code: 'tool_not_allowlisted',
        reason: `step ${step.id}: ${step.agent} may not use ${step.toolName}`,
      };
    }
    const mismatch = classMismatch(step);
    if (mismatch !== null) {
      // The planner's expectation is advisory, but a disagreement about what
      // an action *is* means the plan was reasoned about as something other
      // than what will happen. That is worth stopping for.
      return {
        status: 'rejected',
        code: 'action_class_mismatch',
        reason: `step ${step.id}: ${mismatch}`,
      };
    }

    // A local step reaches nothing outside the instance and so has no channel
    // to resolve — see `needsChannel`. Requiring one for every step made a
    // plan of ordinary reads (`crm.read`, `memory.recall`,
    // `escalate_to_human`) rejected outright, even though the planner's own
    // catalogue advertises those tools.
    if (!needsChannel(step.toolName)) continue;

    // The FIRST of two resolutions. This one asks whether the charter could
    // ever serve this step at all — feasibility — and it rejects the plan
    // whole, because a step that fails on its own leaves every step before it
    // already done. Availability is asked again at execution time, below.
    //
    // `unavailable` is deliberately NOT rejected here: a binding that is down
    // right now is an execution-time fact, and refusing it here would lose
    // the audit trail that the second resolution leaves behind.
    const channel = resolveChannel(bundle, request.bindings, step.toolName, targetIdOf(step));
    if (channel.status === 'no_channel') {
      return {
        status: 'rejected',
        code: 'no_channel_for_tool',
        reason: `step ${step.id}: no_channel_for_tool — ${channel.reason}`,
      };
    }
    if (channel.status === 'ambiguous') {
      return {
        status: 'rejected',
        code: 'ambiguous_channel',
        reason: `step ${step.id}: ambiguous_channel — ${channel.systems.join(', ')}`,
      };
    }
    // A charter may declare a system the code does not implement yet, and that
    // is a fine state to be in. Discovering it mid-execution is not.
    if (
      channel.status === 'resolved' &&
      request.registry.resolve(channel.system, channel.channel, step.toolName) === null
    ) {
      return {
        status: 'rejected',
        code: 'no_adapter_for_system',
        reason: `step ${step.id}: no_adapter_for_system — ${channel.system}`,
      };
    }
  }

  // The plan is bound to the job before a single step runs, so that a re-plan
  // is refused rather than half-applied on top of work already done.
  const binding = await bindPlanToJob(job.jobId, plan, { businessId: job.businessId });
  if (binding.status === 'conflict') {
    return {
      status: 'rejected',
      code: 'plan_changed_mid_flight',
      reason:
        `job ${job.jobId} is already executing plan ${binding.storedHash.slice(0, 12)}; ` +
        `${binding.offeredHash.slice(0, 12)} is a different plan and its steps cannot be ` +
        'merged onto work that has already happened',
    };
  }
  const planHash = binding.planHash;
  const alreadyDone = await completedSteps(job.jobId, planHash, {
    businessId: job.businessId,
  });

  const records: StepRecord[] = [];
  let current = job;

  for (const step of topologicalOrder(plan)) {
    if (alreadyDone.has(step.id)) {
      // An earlier run of THIS plan finished this step. Re-running it would
      // send the message a second time; the phase is left alone because
      // nothing happened in this run to move it.
      const externalId = alreadyDone.get(step.id) ?? null;
      records.push({
        stepId: step.id,
        outcome: { status: 'done', result: null, spendRecorded: false, externalId },
        externalId,
        skipped: true,
      });
      continue;
    }

    const outcome = await executeStep({
      job: current,
      stepId: step.id,
      agent: step.agent,
      bundle,
      toolName: step.toolName,
      toolInput: step.input,
      perform: async (redacted) => performStep(request, step, redacted),
      counterpartyTags: request.counterpartyTags,
      rampLevel: request.rampLevel,
      planHash,
      ...(request.now !== undefined ? { now: request.now } : {}),
    });
    records.push({
      stepId: step.id,
      outcome,
      externalId: outcome.status === 'done' ? outcome.externalId : null,
      skipped: false,
    });

    if (outcome.status !== 'done') {
      // Anything other than `done` ends the run here: an approval to wait for,
      // a window to sleep through, or a refusal. The remaining steps are not
      // abandoned — the job carries the phase that says what happens next.
      return {
        status: 'halted',
        steps: records,
        at: step.id,
        reason: outcome.status === 'refused' ? outcome.code : outcome.status,
      };
    }

    // executeStep moves the job to `verify` after each step. A plan with more
    // steps to run has to come back to `execute`, and that transition is
    // recorded like every other.
    const reloaded = await loadJob(current.jobId, { businessId: current.businessId });
    if (reloaded === null) return { status: 'halted', steps: records, at: step.id, reason: 'job vanished' };
    current = reloaded;

    if (records.length < plan.steps.length && current.phase === 'verify') {
      current = await transition(current.jobId, {
        to: 'execute',
        actor: 'orchestrator',
        reason: `next step after ${step.id}`,
        businessId: current.businessId,
      });
    }
  }

  return { status: 'done', steps: records };
}

/**
 * Load the business's bindings, then run the plan.
 *
 * The thin entry point that makes `loadBindings` reachable from production.
 * `runPlan` takes `bindings` as a parameter so a test can inject them without
 * a table write; left at that, the store would compile and nobody would read
 * it — the exact shape of defect this codebase has hit four times.
 */
export type RunPlanForJobRequest = Omit<RunPlanRequest, 'bindings'>;

export async function runPlanForJob(request: RunPlanForJobRequest): Promise<RunPlanResult> {
  const bindings = await loadBindings({ businessId: request.job.businessId });
  return runPlan({ ...request, bindings });
}

/**
 * Perform one step's side effect against the system that serves it.
 *
 * The SECOND resolution, and it runs *after* `evaluateToolCall` has permitted
 * the call — `executeStep` only reaches `perform` once the gate has allowed and
 * the intent is recorded. A connection that dropped between planning and
 * execution therefore leaves an audit trail instead of vanishing.
 *
 * Every failure leaves by way of `StepChannelError`, which `executeStep`
 * catches and turns into an outcome. Nothing here returns a value that could
 * be mistaken for a completed action.
 */
async function performStep(
  request: RunPlanRequest,
  step: PlanStep,
  redactedInput: unknown,
): Promise<StepEffect> {
  if (!needsChannel(step.toolName)) {
    // A local step: nothing leaves the instance, so there is nothing to
    // connect to. There is no local tool executor either — this returns no
    // result rather than pretending to have read something — which is why
    // `crm.read` in a plan yields `null` today. Building that executor is
    // separate work; what matters here is that a local step is not refused
    // for lacking a connection it could never need.
    return { output: null, externalId: null };
  }

  const resolution = resolveChannel(
    request.bundle,
    request.bindings,
    step.toolName,
    targetIdOf(step),
  );
  if (resolution.status !== 'resolved') {
    // Retryable. A binding that is `disconnected`, or a row that has not been
    // written yet, is the textbook transient condition: it may be live again
    // in five minutes, and the scheduler already runs that loop. Failing the
    // job terminally for it threw away work that nothing was wrong with.
    throw new StepChannelError('channel_unavailable', JSON.stringify(resolution), true);
  }

  const adapter = request.registry.resolve(resolution.system, resolution.channel, step.toolName);
  if (adapter === null) {
    throw new StepChannelError('no_adapter_for_system', resolution.system);
  }

  const binding = request.bindings.find((b) => b.system === resolution.system);
  const credentialRef = binding?.credentialRef ?? null;
  const credential = credentialRef === null ? null : await request.credentials.resolve(credentialRef);
  if (credentialRef !== null && credential === null) {
    // NOT retryable, unlike `channel_unavailable` above. A ref that does not
    // resolve is a misconfiguration — a misspelling, or a secret that was
    // never provisioned — and waiting five minutes does not provision it.
    // Retrying here would spin until someone read the logs anyway.
    throw new StepChannelError('credential_unavailable', credentialRef);
  }

  const result = await callWithDeadline(
    adapter,
    {
      toolName: step.toolName,
      // The gate's redacted payload, never `step.input`. This is the only
      // payload an adapter ever sees.
      input: redactedInput,
      credential,
      // The host this binding points the connection at, or null for the
      // adapter's own default.
      endpoint: binding?.endpoint ?? null,
      // Stable across retries of this same attempt, so an ambiguous timeout
      // cannot become a second real order.
      idempotencyKey: canonicalHash({
        jobId: request.job.jobId,
        stepId: step.id,
        input: step.input,
      }),
      signal: AbortSignal.timeout(request.adapterTimeoutMs ?? ADAPTER_TIMEOUT_MS),
    },
    request.adapterTimeoutMs ?? ADAPTER_TIMEOUT_MS,
  );

  // Acting on the result is the whole point. Ignoring it would record an
  // unimplemented browser call as an order placed, and send the confirmation.
  if (!result.ok) {
    throw new StepChannelError(result.code, result.message, result.retryable);
  }
  return { output: result.output, externalId: result.externalId };
}

/**
 * Run one adapter call, and give up on it if it outlasts the deadline.
 *
 * Retryable on expiry: a call that timed out may or may not have landed at the
 * far end, which is precisely the ambiguity `idempotencyKey` exists for. Its
 * own code — `adapter_timeout` — rather than being folded into
 * `channel_unavailable`, because "the far end is unreachable" and "the far end
 * answered too slowly, or not at all, after we already sent it something" are
 * different situations for whoever reads the audit trail.
 */
async function callWithDeadline(
  adapter: ExternalAdapter,
  call: Parameters<ExternalAdapter['execute']>[0],
  timeoutMs: number,
): Promise<AdapterResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new StepChannelError(
            'adapter_timeout',
            `${adapter.system} did not answer within ${timeoutMs}ms`,
            true,
          ),
        ),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([adapter.execute(call), deadline]);
  } finally {
    // The adapter's own promise may still be pending; nothing here can cancel
    // it beyond the AbortSignal it was already handed. Clearing the timer is
    // what stops a finished call from holding the event loop open.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Does this step reach outside the instance, and therefore need a channel?
 *
 * `isOutbound` (`policy/classify.ts`) is the single definition of "something
 * leaves this instance", and it already drives the outbound kill switch,
 * redaction and quiet hours. Reusing it means a step is routed through a
 * signed connection under exactly the conditions its payload is redacted
 * under — one list to keep correct rather than two that will disagree.
 *
 * Written as a positive membership test, not as "everything that is not
 * read-only": a local write (`file.write`, the `memory.write_*` family,
 * `charter.apply_amendment`) is classified and still reaches nothing, and
 * demanding a charter connection for a filesystem write would be a rule the
 * charter cannot satisfy.
 *
 * The failure mode to watch is the mirror image: a genuinely outbound tool
 * missing from `OUTBOUND_TOOLS` would skip both the connection requirement
 * and redaction. That is why the invariant in
 * `src/policy/positive-controls.test.ts` ties the list to `addresseeOf`.
 */
function needsChannel(toolName: string): boolean {
  return isOutbound(toolName);
}

/**
 * The action class the gate will settle on for this step.
 *
 * Derived here rather than trusting `expectedActionClass`, which is advisory:
 * the routing decision must follow what the call *is*.
 */
function actionClassOf(step: PlanStep): ActionClass | null {
  const base = classifyAction(step.toolName);
  return base === null ? null : refineActionClass(base, step.input);
}

/** The target this step addresses, derived identically at both resolutions. */
function targetIdOf(step: PlanStep): string | null {
  return deriveTargetId(step.toolName, step.input, actionClassOf(step));
}

/**
 * Does the gate agree with the planner about what this step is?
 *
 * Only checked when the planner stated an expectation. Silence is not a claim,
 * and demanding one would push planners toward guessing.
 */
function classMismatch(step: PlanStep): string | null {
  if (step.expectedActionClass === null) return null;

  const actual = actionClassOf(step);
  if (actual === step.expectedActionClass) return null;

  return `planned as ${step.expectedActionClass}, the gate classifies it as ${actual ?? 'read-only'}`;
}

function describe(problem: NonNullable<ReturnType<typeof planProblems>[number]>): string {
  switch (problem.kind) {
    case 'duplicate_step_id':
      return `duplicate step id ${problem.stepId}`;
    case 'self_dependency':
      return `step ${problem.stepId} depends on itself`;
    case 'unknown_dependency':
      return `step ${problem.stepId} depends on unknown step ${problem.dependsOn}`;
    case 'cycle':
      return `steps form a cycle: ${problem.stepIds.join(' → ')}`;
  }
}
