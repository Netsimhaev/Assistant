import type { ActionClass } from '../domain/action.js';
import type { ConnectionBinding } from '../domain/connection.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { AutonomyLevel } from '../domain/trust.js';
import { planProblems, topologicalOrder, type Plan, type PlanStep } from '../domain/plan.js';
import { classifyAction, refineActionClass } from '../policy/classify.js';
import { canonicalHash } from '../util/canonical.js';
import type { AdapterRegistry } from './adapters/registry.js';
import { loadBindings } from './bindings.js';
import { deriveTargetId, resolveChannel } from './channels.js';
import type { CredentialSource } from './credentials.js';
import { executeStep, type StepOutcome } from './execute.js';
import { loadJob, transition } from './jobs.js';
import { planStepIsFeasible } from './catalogue.js';
import { StepChannelError } from './step-error.js';
import type { Job } from './jobs.js';

/**
 * How long one external call may take before it is abandoned.
 *
 * A step that never returns holds the whole plan — and the job's phase —
 * open indefinitely, which is worse than a failure the scheduler can retry.
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
}

export interface StepRecord {
  stepId: string;
  outcome: StepOutcome;
}

export type RunPlanResult =
  | { status: 'rejected'; reason: string }
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
 */
export async function runPlan(request: RunPlanRequest): Promise<RunPlanResult> {
  const { job, bundle, plan } = request;

  const problems = planProblems(plan);
  if (problems.length > 0) {
    return { status: 'rejected', reason: describe(problems[0]!) };
  }

  for (const step of plan.steps) {
    if (!planStepIsFeasible(step.agent, step.toolName)) {
      return {
        status: 'rejected',
        reason: `step ${step.id}: ${step.agent} may not use ${step.toolName}`,
      };
    }
    const mismatch = classMismatch(step);
    if (mismatch !== null) {
      // The planner's expectation is advisory, but a disagreement about what
      // an action *is* means the plan was reasoned about as something other
      // than what will happen. That is worth stopping for.
      return { status: 'rejected', reason: `step ${step.id}: ${mismatch}` };
    }

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
        reason: `step ${step.id}: no_channel_for_tool — ${channel.reason}`,
      };
    }
    if (channel.status === 'ambiguous') {
      return {
        status: 'rejected',
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
        reason: `step ${step.id}: no_adapter_for_system — ${channel.system}`,
      };
    }
  }

  const records: StepRecord[] = [];
  let current = job;

  for (const step of topologicalOrder(plan)) {
    const outcome = await executeStep({
      job: current,
      stepId: step.id,
      agent: step.agent,
      bundle,
      toolName: step.toolName,
      toolInput: step.input,
      perform: (redacted) => performStep(request, step, redacted),
      counterpartyTags: request.counterpartyTags,
      rampLevel: request.rampLevel,
      ...(request.now !== undefined ? { now: request.now } : {}),
    });
    records.push({ stepId: step.id, outcome });

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
): Promise<unknown> {
  const resolution = resolveChannel(
    request.bundle,
    request.bindings,
    step.toolName,
    targetIdOf(step),
  );
  if (resolution.status !== 'resolved') {
    throw new StepChannelError('channel_unavailable', JSON.stringify(resolution));
  }

  const adapter = request.registry.resolve(resolution.system, resolution.channel, step.toolName);
  if (adapter === null) {
    throw new StepChannelError('no_adapter_for_system', resolution.system);
  }

  const binding = request.bindings.find((b) => b.system === resolution.system);
  const credentialRef = binding?.credentialRef ?? null;
  const credential = credentialRef === null ? null : await request.credentials.resolve(credentialRef);
  if (credentialRef !== null && credential === null) {
    // A binding that names a ref is a binding that expects a secret. Calling
    // the adapter with `null` instead would let it decide, and the mail
    // adapter's own refusal is a different, less legible failure.
    throw new StepChannelError('credential_unavailable', credentialRef);
  }

  const result = await adapter.execute({
    toolName: step.toolName,
    // The gate's redacted payload, never `step.input`. This is the only
    // payload an adapter ever sees.
    input: redactedInput,
    credential,
    // Stable across retries of this same attempt, so an ambiguous timeout
    // cannot become a second real order.
    idempotencyKey: canonicalHash({
      jobId: request.job.jobId,
      stepId: step.id,
      input: step.input,
    }),
    signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS),
  });

  // Acting on the result is the whole point. Ignoring it would record an
  // unimplemented browser call as an order placed, and send the confirmation.
  if (!result.ok) {
    throw new StepChannelError(result.code, result.message, result.retryable);
  }
  return result.output;
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
