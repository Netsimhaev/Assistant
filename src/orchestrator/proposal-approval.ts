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
 */
import type { Queryable } from '../db/pool.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { Proposal } from '../domain/proposal.js';
import { enqueueApproval } from '../governance/approvals.js';
import { buildFacts } from '../policy/facts.js';
import { assessRisk } from '../policy/risk.js';
import { proposalToApprovalText } from './proposal-to-plan.js';

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
  options: { businessId?: string; db?: Queryable } = {},
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

  return enqueueApproval(
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
}
