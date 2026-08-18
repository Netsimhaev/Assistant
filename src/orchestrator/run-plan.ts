import type { PolicyBundle } from '../domain/policy.js';
import type { AutonomyLevel } from '../domain/trust.js';
import { planProblems, topologicalOrder, type Plan, type PlanStep } from '../domain/plan.js';
import { classifyAction, refineActionClass } from '../policy/classify.js';
import { executeStep, type StepOutcome } from './execute.js';
import { loadJob, transition } from './jobs.js';
import { planStepIsFeasible } from './catalogue.js';
import type { Job } from './jobs.js';

export interface RunPlanRequest {
  job: Job;
  bundle: PolicyBundle;
  plan: Plan;
  /** Performs one step's side effect once the gate has permitted it. */
  perform: (step: PlanStep, redactedInput: unknown) => Promise<unknown>;
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
      perform: (redacted) => request.perform(step, redacted),
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
 * Does the gate agree with the planner about what this step is?
 *
 * Only checked when the planner stated an expectation. Silence is not a claim,
 * and demanding one would push planners toward guessing.
 */
function classMismatch(step: PlanStep): string | null {
  if (step.expectedActionClass === null) return null;

  const base = classifyAction(step.toolName);
  const actual = base === null ? null : refineActionClass(base, step.input);
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
