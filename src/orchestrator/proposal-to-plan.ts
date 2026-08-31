/**
 * A proposal's single action, compiled into the one-step plan the engine runs
 * (spec §7).
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
