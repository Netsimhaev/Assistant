import { z } from 'zod';
import { ActionClass } from './action.js';
import { AgentId } from './audit.js';

/**
 * One step of a plan.
 *
 * `input` is `unknown` here and validated per-intent downstream: the planner is
 * a model, and a schema loose enough for every intent is a schema that checks
 * nothing. What is *not* loose is everything the gate reads — `agent`,
 * `toolName` and `expectedActionClass` are closed enums, so a plan naming an
 * agent or a tool that does not exist fails to parse rather than failing
 * halfway through execution.
 */
export const PlanStep = z.object({
  id: z.string().min(1),
  agent: AgentId,
  /** What this step is for, in the plan's own vocabulary. */
  intent: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  /** DAG edges. Every id must exist in the same plan. */
  dependsOn: z.array(z.string()).default([]),
  /**
   * What the planner believes this step will be classified as.
   *
   * Advisory, never authoritative: the gate classifies the call itself. Its
   * value is that a mismatch is a signal — a step the planner thought was a
   * draft and the gate classified as a purchase is worth refusing before it
   * runs, not after.
   */
  expectedActionClass: ActionClass.nullable().default(null),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const Plan = z.object({
  goal: z.string().min(1),
  /** What the planner inferred rather than was told. Each one is a risk. */
  assumptions: z.array(z.string()).default([]),
  /** At most one, because two questions is an interrogation, not a clarification. */
  clarifyingQuestion: z.string().nullable().default(null),
  steps: z.array(PlanStep).min(1),
  estimatedCostMinor: z.number().int().nonnegative().default(0),
});
export type Plan = z.infer<typeof Plan>;

export type PlanProblem =
  | { kind: 'unknown_dependency'; stepId: string; dependsOn: string }
  | { kind: 'duplicate_step_id'; stepId: string }
  | { kind: 'cycle'; stepIds: string[] }
  | { kind: 'self_dependency'; stepId: string };

/**
 * Validate the shape a schema cannot: that the steps form a DAG.
 *
 * A cycle is not a strange plan, it is a plan that never terminates — and the
 * executor would either loop or silently drop steps depending on how it walked
 * the graph. Rejecting it up front means the executor can assume it has an
 * order to walk.
 */
export function planProblems(plan: Plan): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const ids = new Set<string>();

  for (const step of plan.steps) {
    if (ids.has(step.id)) problems.push({ kind: 'duplicate_step_id', stepId: step.id });
    ids.add(step.id);
  }

  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.id) {
        problems.push({ kind: 'self_dependency', stepId: step.id });
      } else if (!ids.has(dep)) {
        problems.push({ kind: 'unknown_dependency', stepId: step.id, dependsOn: dep });
      }
    }
  }

  const cycle = findCycle(plan);
  if (cycle !== null) problems.push({ kind: 'cycle', stepIds: cycle });

  return problems;
}

/**
 * Steps in dependency order.
 *
 * Kahn's algorithm, with ties broken by the order the planner wrote them —
 * so the same plan always executes in the same sequence. A non-deterministic
 * order would make a failure impossible to reproduce from the audit trail,
 * which is the one thing the trail exists for.
 */
export function topologicalOrder(plan: Plan): PlanStep[] {
  const remaining = new Map(plan.steps.map((step) => [step.id, new Set(step.dependsOn)]));
  const ordered: PlanStep[] = [];

  while (remaining.size > 0) {
    const ready = plan.steps.filter(
      (step) => remaining.has(step.id) && remaining.get(step.id)?.size === 0,
    );
    if (ready.length === 0) break; // a cycle; planProblems reports it

    for (const step of ready) {
      ordered.push(step);
      remaining.delete(step.id);
      for (const deps of remaining.values()) deps.delete(step.id);
    }
  }

  return ordered;
}

function findCycle(plan: Plan): string[] | null {
  const ordered = topologicalOrder(plan);
  if (ordered.length === plan.steps.length) return null;
  const placed = new Set(ordered.map((step) => step.id));
  return plan.steps.filter((step) => !placed.has(step.id)).map((step) => step.id);
}
