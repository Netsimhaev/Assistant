/**
 * A proposal's single action, compiled into the two things that consume it:
 * the one-step plan the engine runs (spec §7), and the two lines the owner
 * reads on the approval card (spec §4).
 *
 * They live together because they are the same act of translation from the
 * same value, and because keeping them apart is how the card's rule — the
 * headline is the *action's*, never the proposal's — ends up restated in a
 * file that never mentions why.
 *
 * Pure and synchronous — no model, no database, no clock. The judgement
 * already happened when the proposal was made; nothing here decides anything.
 * That separation is what lets the whole compilation be tested on a machine
 * with no API key.
 *
 * The step id is a constant rather than a generated one. A one-step plan has
 * nothing to disambiguate, and a random id would make `plan_hash` differ
 * between two compilations of the same proposal — which would defeat the
 * resumption machinery that keys on it.
 */

import type { Plan } from '../domain/plan.js';
import type { Proposal } from '../domain/proposal.js';

const ONLY_STEP_ID = 'step-1';

export function proposalToPlan(
  proposal: Proposal,
  options: { goal: string },
): Plan | null {
  const action = proposal.action;
  if (action === null) return null;

  return {
    goal: options.goal,
    // The reasons are the assumptions: each is a claim the proposal rests on,
    // and each already carries the finding it came from.
    assumptions: proposal.reasons.map((reason) => reason.text),
    clarifyingQuestion: proposal.clarifyingQuestion,
    steps: [
      {
        id: ONLY_STEP_ID,
        agent: action.agent,
        // Both halves: what it is and what it is for. The audit row and the
        // approval card are read by a person months later, and "mail.send"
        // alone tells them nothing about why it was ever proposed.
        intent: `${action.headline} — ${action.purpose}`,
        toolName: action.toolName,
        input: action.input,
        dependsOn: [],
        expectedActionClass: action.expectedActionClass,
      },
    ],
    estimatedCostMinor: 0,
  };
}

/**
 * The same proposal, rendered as the two lines a person reads on the approval
 * card (spec §4) — `GateContext.proposalText`'s shape exactly.
 *
 * The whole justification for this sub-project is that the owner reads
 * "אשלח מייל לדנה כדי לאשר את מועד ההתקנה" instead of
 * `mail.send · email.initiate · רצועה sensitive`. The gate has carried the
 * field since fix round 1; this is the function that fills it.
 *
 * **`headline` is `action.headline` for every stance, never
 * `proposal.headline`.** That is spec §4's named rule, and its reason is the
 * whole reason: for `advise_against` the proposal's own headline is the
 * objection ("אני נגד חתימה") while the action is the alternative ("אשלח לו
 * הודעה בוואטסאפ"), and only the alternative is ever what an approval
 * authorises. Titling the card with the objection puts the owner in front of
 * an Approve button under the words "I am against signing" with no way to
 * tell whether they are approving the objection or the send. The rule is not
 * stance-conditional on purpose: a conditional here would be one `stance`
 * enum member away from reintroducing exactly that.
 *
 * `null` when there is no action. No action means no approval will ever be
 * raised, so there is nothing to title — `ask`, `no_action`, and an
 * `advise_against` that carries no alternative all land here.
 *
 * **The joining is ` · ` and not a newline**, because the card renders
 * `detail` inside a single escaped `<p>` (`src/dashboard/views.ts`) where a
 * newline collapses and silently glues two sentences into one. ` · ` is also
 * what `defaultApprovalDetail` (`src/policy/engine.ts`) already puts on this
 * same field, so a card with a proposal behind it and one without read the
 * same way. The purpose comes first — it is why anyone would approve — and
 * the reasons follow in the order the proposal made them.
 */
export function proposalToApprovalText(
  proposal: Proposal,
): { headline: string; detail: string } | null {
  const action = proposal.action;
  if (action === null) return null;

  return {
    headline: action.headline,
    detail: [action.purpose, ...proposal.reasons.map((reason) => reason.text)].join(' · '),
  };
}
