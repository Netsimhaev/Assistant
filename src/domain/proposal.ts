import { z } from 'zod';
import { ActionClass } from './action.js';
import { AgentId } from './audit.js';
import { IntentName, SourceRef } from './reading.js';

/**
 * Where the assistant stands on what it read.
 *
 * `advise_against` is the member that did not exist in any form before: the
 * system could plan or not plan, and had no way to say "I think you should
 * not, and here is why". It may carry an *alternative* action — and that
 * alternative, never the objection, is what an approval authorises
 * (spec §4).
 */
export const Stance = z.enum(['act', 'advise_against', 'ask', 'no_action']);
export type Stance = z.infer<typeof Stance>;

/**
 * One reason, tied to the finding it rests on.
 *
 * The citation is not decoration. A reason that points at nothing is an
 * opinion, and the reading layer already refuses claims that cite nothing —
 * there is no argument for relaxing the rule one layer up.
 */
export const Reason = z.object({
  text: z.string().min(1),
  /** The `Finding.label` in the reading this reason rests on. */
  findingLabel: z.string().min(1),
  sourceRef: SourceRef,
});
export type Reason = z.infer<typeof Reason>;

/**
 * The single thing that would happen.
 *
 * `agent`, `intent` and `expectedActionClass` are closed enums, so a proposal
 * naming an agent or an intent that does not exist fails to parse rather than
 * failing when something tries to run it. `toolName` is checked against the
 * capability catalogue in `proposalProblems` — a closed enum here would have
 * to be written by hand beside the allowlists and would drift from them.
 *
 * `purpose` is required. "I will send Dana an email" is an act; "to confirm
 * the installation date" is why anyone would approve it, and an approval
 * screen without it asks the owner to guess.
 */
export const ProposedAction = z.object({
  headline: z.string().min(1),
  purpose: z.string().min(1),
  intent: IntentName,
  agent: AgentId,
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  expectedActionClass: ActionClass.nullable().default(null),
});
export type ProposedAction = z.infer<typeof ProposedAction>;

/**
 * What the assistant proposes, in the form the owner decides on.
 *
 * `reasons` is `.min(1)` for every stance including `no_action`: "I read it
 * and nothing follows" without a reason is exactly the claim nobody can
 * disagree with, and therefore the one worth least.
 *
 * The reading's own summary is deliberately absent. It is already stored in
 * `document_readings`; asking the model for it again would produce a second
 * version that drifts from the first. What is saved once is not asked twice.
 */
export const Proposal = z.object({
  stance: Stance,
  /** One line the owner reads first: "אני נגד חתימה על החוזה". */
  headline: z.string().min(1),
  reasons: z.array(Reason).min(1),
  action: ProposedAction.nullable(),
  /** At most one. Two questions are an interrogation, not a clarification. */
  clarifyingQuestion: z.string().nullable().default(null),
});
export type Proposal = z.infer<typeof Proposal>;
