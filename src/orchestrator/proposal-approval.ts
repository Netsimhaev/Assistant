/**
 * Turn a proposal into the question the owner actually answers.
 *
 * **Why this exists rather than routing through the gate.** An approval is
 * created only when `evaluateToolCall` reaches stage 10. Stage 8 sits in front
 * of it and refuses every outbound class while its ramp level is `draft_only`
 * — which is every class, since `RAMP_FLOOR` is the floor and no production
 * caller raises it. Routing the conductor's proposals through the gate would
 * therefore produce exactly zero cards. See §3 of the spec.
 *
 * The separation is not a workaround. "Do you want this to happen?" is a
 * question for a person and "may this tool run right now?" is a question for
 * the gate, and the system had merged them. This module asks only the first.
 * The gate still answers the second, unchanged, if the plan ever runs.
 *
 * **What this must never do:** grant authority. The approval it writes carries
 * the proposal's words and the proposed payload. It does not set a ramp level,
 * does not write a `job_authorizations` row, and does not mark anything as
 * boss-provenance. `conductor-invariants.test.ts` holds all three.
 *
 * **What bypassing the gate silently dropped, and what is restored here.** The
 * gate was carrying two things at stage 10, not one: it wrote the
 * `approval_requests` row *and* it told the owner the row existed
 * (`policy/engine.ts`, the only `notifier.notify(...)` call in the codebase).
 * Taking the first without the second meant an installation with all six SMTP
 * variables and `APPROVAL_NOTIFY_TO` correctly set got no email at all for a
 * conductor card: the card existed, the fuse burned, `expireOverdue` retired
 * it, and the owner never knew (I3). `notify` is threaded in as an option and
 * the gate's contract is kept exactly — a send failure is non-fatal and is
 * recorded as an `approval_notify_failed` audit row rather than thrown.
 */
import { appendAudit } from '../audit/log.js';
import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import type { ActionFacts, PolicyBundle } from '../domain/policy.js';
import type { Proposal } from '../domain/proposal.js';
import { enqueueApproval, getApproval } from '../governance/approvals.js';
import type { ApprovalNotifier } from '../governance/notify.js';
import { buildFacts } from '../policy/facts.js';
import { assessRisk } from '../policy/risk.js';
import { proposalToApprovalText } from './proposal-to-plan.js';

/** Where to tell the owner a card is waiting. The same shape `Runtime.notify` carries. */
export interface NotifyTarget {
  notifier: ApprovalNotifier;
  dashboardBaseUrl: string;
}

/**
 * Tell the owner a card is waiting, without making delivery load-bearing.
 *
 * Deliberately the same contract as `evaluateToolCall`'s own notify block
 * (`src/policy/engine.ts`), down to the audit reason prefix: the row already
 * exists, the dashboard already shows it, and the scheduler will expire it on
 * schedule whether or not this ever runs. An approval that vanished because
 * an SMTP server was down would be far worse than one nobody was emailed
 * about. `createEmailNotifier` never throws and never hangs — its own
 * `withDeadline` races the transport against a five-second timer rather than
 * trusting an `AbortSignal` nothing is obliged to check — so the try/catch
 * here covers the two database calls around it, not a hung socket.
 *
 * Never rethrows. The caller (`conduct.ts`) has already committed the
 * approval and is about to move the job to `await_approval`; a failure to
 * send mail must not undo either.
 */
async function notifyOwner(
  approvalId: string,
  target: NotifyTarget,
  context: { businessId: string; jobId: string | null; facts: ActionFacts; charterVersion: string },
): Promise<void> {
  const { businessId, jobId, facts, charterVersion } = context;
  try {
    const request = await getApproval(approvalId, { businessId });
    if (request === null) {
      throw new Error('approval vanished immediately after being queued');
    }
    const delivered = await target.notifier.notify(
      request,
      `${target.dashboardBaseUrl}/a/${approvalId}`,
    );
    if (!delivered.ok) throw new Error(delivered.error ?? 'notify returned not-ok');
  } catch (error) {
    try {
      await appendAudit(
        {
          actor: 'system',
          kind: 'incident',
          jobId,
          actionClass: facts.actionClass,
          charterVersion,
          provenance: facts.provenance,
          inputHash: facts.inputHash,
          reason:
            `approval_notify_failed:${approvalId} via ${target.notifier.channel} — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        },
        { businessId },
      );
    } catch {
      // The audit write itself failed — the same bad moment that most likely
      // broke the send. Swallowed for the reason in this function's docblock:
      // the approval is already committed and the job is about to move, and
      // neither may be undone by a failure to record a failure to notify.
    }
  }
}

/**
 * Said on every card the conductor raises.
 *
 * Approving does not execute: the ramp holds every outbound class in draft.
 * "I approved it and nothing happened" is indistinguishable from a broken
 * system unless it was said in advance, so it is said in advance.
 */
export const RAMP_HONESTY =
  'אישור כאן מתעד את החלטתך ואינו מבצע את הפעולה — כל פעולה יוצאת מוחזקת כרגע במצב טיוטה.';

export interface RaiseInput {
  jobId: string | null;
  proposal: Proposal;
  bundle: PolicyBundle;
}

export async function raiseProposalApproval(
  input: RaiseInput,
  options: { businessId?: string; db?: Queryable; notify?: NotifyTarget } = {},
): Promise<string | null> {
  const { proposal } = input;
  const text = proposalToApprovalText(proposal);
  // No action means no approval: there is nothing to title and nothing to
  // approve. The reading still reaches the owner through the readings screen.
  if (text === null || proposal.action === null) return null;

  const facts = buildFacts(proposal.action.toolName, proposal.action.input, {
    // The conductor only ever handles documents that arrived from outside.
    // Not a parameter: a caller able to ask for `boss` here would be a caller
    // able to buy the standing-authorisation and first-contact exemptions for
    // a document a stranger wrote.
    provenance: 'unknown_external',
    chainDepth: 1,
    // No resolver exists. Written on purpose rather than omitted — see
    // `FactsContext.counterpartyTags`.
    counterpartyTags: [],
    // Never true here: the chain read a document from outside, which is the
    // exact condition that disqualifies the exemption.
    provenanceChainDerived: false,
  });

  // A read-only tool has no action class, and both `assessRisk` and
  // `enqueueApproval` refuse one. That is a proposal to look something up, not
  // to do something — it belongs on the readings screen, not on a card.
  if (facts.actionClass === null) return null;

  const risk = await assessRisk(facts, input.bundle);

  const approvalId = await enqueueApproval(
    {
      jobId: input.jobId,
      facts,
      risk,
      proposedInput: proposal.action.input,
      summary: text.headline,
      detail: `${text.detail}\n\n${RAMP_HONESTY}`,
    },
    options,
  );

  // After the row exists, never before: the notification's whole subject is a
  // card the owner can already open.
  if (options.notify !== undefined) {
    await notifyOwner(approvalId, options.notify, {
      businessId: options.businessId ?? config.businessId,
      jobId: input.jobId,
      facts,
      charterVersion: input.bundle.charterVersion,
    });
  }

  return approvalId;
}
