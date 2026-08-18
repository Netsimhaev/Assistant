import { decide, getApproval, type Decision } from '../governance/approvals.js';
import { loadJob, transition } from './jobs.js';
import type { Job } from './jobs.js';

export interface ResumeResult {
  approvalId: string;
  state: string;
  /** The job's phase after the decision, or null when the approval had no job. */
  jobPhase: Job['phase'] | null;
}

/**
 * Record a human's answer and move the job it was blocking.
 *
 * `decide` wrote the row and stopped there, so an approved action left its job
 * parked in `await_approval` with nothing to restart it — the approval broker
 * generated and resolved decisions that reached nobody and moved nothing.
 *
 * The two halves are not one transaction on purpose. The decision is the
 * human's, and it is recorded whether or not the job can accept it; a job that
 * has since been halted must not silently discard the answer.
 */
export async function applyDecision(
  approvalId: string,
  outcome: 'approved' | 'denied',
  decision: Decision,
  options: { businessId?: string } = {},
): Promise<ResumeResult> {
  const approval = await decide(approvalId, outcome, decision, options);

  if (approval.jobId === null) {
    return { approvalId, state: approval.state, jobPhase: null };
  }

  const job = await loadJob(approval.jobId, options);
  if (job === null || job.phase !== 'await_approval') {
    // The answer is recorded; the job simply is not waiting on it any more.
    return { approvalId, state: approval.state, jobPhase: job?.phase ?? null };
  }

  const denied = approval.state === 'denied';
  const moved = await transition(job.jobId, {
    // A denial closes the job rather than failing it: the system did what was
    // asked of it and a person said no. That is an outcome, not a fault.
    to: denied ? 'closed' : 'execute',
    actor: 'human',
    reason: `${approval.state}:${approvalId} by ${decision.by}`,
    ...(options.businessId !== undefined ? { businessId: options.businessId } : {}),
  });

  return { approvalId, state: approval.state, jobPhase: moved.phase };
}

/** The approval a job is currently blocked on, if any. */
export async function blockingApproval(
  approvalId: string,
  options: { businessId?: string } = {},
) {
  return getApproval(approvalId, options);
}
