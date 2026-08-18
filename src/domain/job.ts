import { z } from 'zod';
import { AgentId } from './audit.js';

/**
 * The loop as durable state.
 *
 * `understand → plan → execute → verify → followup → remember → update` is a
 * column in a row, not a sentence in a prompt. That is the founding decision of
 * the orchestrator (docs/02-orchestrator.md): the work runs for days, has to
 * survive process death, and has to be auditable afterwards. A model
 * conversation is none of those three.
 *
 * `think` is deliberately absent — it is the planner's reasoning inside `plan`,
 * and making it a durable state buys nothing.
 */
export const JobPhase = z.enum([
  'intake',
  'understand',
  'plan',
  'await_approval',
  'execute',
  'verify',
  'followup',
  'remember',
  'update',
  'closed',
  'failed',
  'halted',
]);
export type JobPhase = z.infer<typeof JobPhase>;

/**
 * Which phase may follow which.
 *
 * Written down rather than left to the code that calls `transition`. An
 * illegal move is then a loud error at one chokepoint instead of a row that
 * quietly claims a job went from `intake` straight to `closed`.
 */
export const LEGAL_TRANSITIONS: Record<JobPhase, readonly JobPhase[]> = {
  intake: ['understand', 'failed', 'halted'],
  understand: ['plan', 'closed', 'failed', 'halted'],
  plan: ['execute', 'await_approval', 'closed', 'failed', 'halted'],
  // An approval can come back approved (execute), denied (closed), or expire
  // into the followup phase to be re-queued.
  await_approval: ['execute', 'followup', 'closed', 'failed', 'halted'],
  execute: ['verify', 'await_approval', 'followup', 'failed', 'halted'],
  verify: ['execute', 'followup', 'remember', 'failed', 'halted'],
  // Sleeps on wake_at. Returning to execute is the normal path for anything
  // deferred — a message held back by quiet hours, a retry, a chased reply.
  followup: ['execute', 'remember', 'closed', 'failed', 'halted'],
  remember: ['update', 'closed', 'failed', 'halted'],
  update: ['closed', 'failed', 'halted'],
  // Terminal. `halted` is reachable from anywhere but leads nowhere by design:
  // resuming after a kill switch is a human act that starts a new job.
  closed: [],
  failed: [],
  halted: [],
};

// `z.string()` as the last union member subsumed the three literals, so the
// schema advertised a constraint it did not have. Closed over AgentId instead.
export const JobActor = z.union([
  z.literal('orchestrator'),
  z.literal('human'),
  z.literal('system'),
  AgentId,
]);
export type JobActor = z.infer<typeof JobActor>;

export function canTransition(from: JobPhase, to: JobPhase): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}
