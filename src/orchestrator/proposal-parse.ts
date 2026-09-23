/**
 * Turning what the model said into a `Proposal`, or into a stated reason why
 * it is not one (spec §8).
 *
 * Same shape as `src/documents/reading-parse.ts`: a balanced-brace scan that
 * tolerates prose and fences, zod for the shape, and a separate structural
 * pass for what a schema cannot express. The scanner is written here rather
 * than imported — it is private in `planner.ts` and in `reading-parse.ts`,
 * and the three callers answer to different prompts and may diverge.
 *
 * Nothing here throws on model output. A response that is not a proposal is a
 * result to record.
 */

import { Proposal } from '../domain/proposal.js';
import type { Reading } from '../domain/reading.js';
import { classifiedToolNames, classifyAction, refineActionClass } from '../policy/classify.js';
import type { CatalogueEntry } from './catalogue.js';

export type ProposalProblem = {
  kind:
    | 'act_without_action'
    | 'action_on_passive_stance'
    | 'ask_without_question'
    | 'reason_cites_unknown_finding'
    | 'tool_not_in_catalogue'
    | 'action_class_mismatch'
    | 'action_tool_cannot_be_carded'
    | 'headline_is_tool_name';
  detail: string;
};

export type ParseOutcome =
  | { status: 'proposed'; proposal: Proposal }
  | { status: 'unproposable'; reason: string };

/**
 * The checks a schema cannot make: stance constraints, citation integrity, and
 * feasibility against the catalogue.
 *
 * Stance constraints live here rather than as zod refinements because a
 * refinement produces an error message nobody can act on, while a named
 * problem can say which rule it broke and why the rule exists.
 */
export function proposalProblems(
  proposal: Proposal,
  reading: Reading,
  catalogue: readonly CatalogueEntry[],
): ProposalProblem[] {
  const problems: ProposalProblem[] = [];
  const { stance, action } = proposal;

  if (stance === 'act' && action === null) {
    problems.push({
      kind: 'act_without_action',
      detail: 'המלצה לפעול שאינה אומרת מה לעשות',
    });
  }
  if ((stance === 'ask' || stance === 'no_action') && action !== null) {
    problems.push({
      kind: 'action_on_passive_stance',
      detail: `עמדה ${stance} אינה יכולה לשאת פעולה`,
    });
  }
  if (stance === 'ask' && proposal.clarifyingQuestion === null) {
    problems.push({ kind: 'ask_without_question', detail: 'עמדת ask בלי שאלה' });
  }

  const known = new Set(reading.findings.map((finding) => finding.label));
  for (const reason of proposal.reasons) {
    if (!known.has(reason.findingLabel)) {
      problems.push({
        kind: 'reason_cites_unknown_finding',
        detail: `נימוק מצטט ממצא שאינו בקריאה: ${reason.findingLabel}`,
      });
    }
  }

  if (action !== null) {
    const entry = catalogue.find((candidate) => candidate.agent === action.agent);
    const offered = entry?.tools.some((tool) => tool.toolName === action.toolName) ?? false;
    if (!offered) {
      problems.push({
        kind: 'tool_not_in_catalogue',
        detail: `${action.agent} אינו מחזיק את ${action.toolName} כרגע`,
      });
    }

    // Advisory, but a mismatch means the proposer intended something other
    // than what will happen — the same rule `Plan` already holds for its
    // steps. §8 claims this check catches an infeasible plan before it runs,
    // and a check that disagrees with the executor about what is feasible
    // catches nothing: it just moves the rejection somewhere with no reason
    // attached. That has now been true twice.
    //
    // Once when `actual === null` was not treated as a mismatch, so a
    // proposal naming a read-only tool *and* declaring a class passed here
    // and `classMismatch` rejected the compiled plan at execution.
    //
    // And once over refinement, which is why `refineActionClass` is applied
    // below rather than `classifyAction` alone: `actionClassOf` in
    // `run-plan.ts` refines, and comparing against the base made the two
    // disagree — a `mail.send` with no `inReplyTo` is `email.reply` to the
    // base and `email.initiate` to the gate. Invisible until the conductor
    // began binding a plan (11/09); before that the job failed earlier, on
    // `no_plan_bound`. The proposal carries the real payload, so there was
    // never a reason for this check to know less than the executor does.
    const base = classifyAction(action.toolName);
    const actual = base === null ? null : refineActionClass(base, action.input);
    if (action.expectedActionClass !== null && action.expectedActionClass !== actual) {
      problems.push({
        kind: 'action_class_mismatch',
        detail: `תוכנן ${action.expectedActionClass}, יסווג ${actual ?? 'קריאה-בלבד'}`,
      });
    }

    // A proposed action is a thing the owner can be asked to approve, and a
    // tool the gate cannot classify can never become a card:
    // `raiseProposalApproval` returns `null` at exactly this condition, the
    // job closes, and nothing reaches the owner.
    //
    // The mismatch check above does not cover it. That one fires only when a
    // class WAS declared; the live run of 11/09 produced the other shape —
    // `toolName: 'agent.request_help'` with `expectedActionClass: null`, which
    // was, at the time, the *correct* declaration for a read-only tool — and
    // it passed every check here on the way to silence. A supplier's quote
    // for ₪11,988 with three weeks to answer reached the owner not at all.
    // (`agent.request_help` is no longer read-only — the envelope work
    // classified it as `agent.delegate` — but the check below still applies
    // to every tool that carries no class today, and to whatever future tool
    // repeats the same shape.)
    //
    // Checked as a positive property of the tool rather than by naming the
    // escalation tools: `escalate_to_human` is today's sole member of
    // `READ_ONLY_TOOLS` with this shape, and a list written here would stop
    // covering the class the moment another one is added.
    //
    // This does not take escalation away from the assistant. Bringing a
    // document to the owner is what raising the card already does, and a
    // proposal that genuinely has nothing to act on says so with its stance —
    // `ask` carries the question, `no_action` and `advise_against` carry the
    // reasoning, and all three reach the owner through the readings screen.
    if (actual === null) {
      problems.push({
        kind: 'action_tool_cannot_be_carded',
        detail:
          `${action.toolName} הוא כלי קריאה-בלבד ואין לו מחלקת פעולה, ולכן אי אפשר להעלות ` +
          `עליו כרטיס לאישור. פעולה מוצעת חייבת להיות משהו שהבעלים יכול לאשר; ` +
          `כדי להביא משהו לידיעתו השתמש בעמדה (ask / no_action / advise_against), לא בכלי.`,
      });
    }

    // Rule 4 of the prompt: a headline says what happens, never a tool name.
    // Checked against a closed set — `classifiedToolNames()` — rather than a
    // pattern on dots or spaces, which would refuse a legitimate Hebrew
    // headline the first time one happened to look like a tool name.
    const headline = action.headline.trim();
    if (headline === action.toolName || classifiedToolNames().includes(headline)) {
      problems.push({
        kind: 'headline_is_tool_name',
        detail: `הכותרת "${action.headline}" היא שם כלי, לא תיאור של מה שקורה`,
      });
    }
  }

  return problems;
}

export function parseProposal(
  raw: string,
  reading: Reading,
  catalogue: readonly CatalogueEntry[],
): ParseOutcome {
  const candidates = extractJsonObjects(raw);
  if (candidates.length === 0) {
    return { status: 'unproposable', reason: 'no JSON object in the response' };
  }

  // Keep the first candidate's complaint, not the last. `extractJsonObjects`
  // yields the outermost object first and then every object nested inside it
  // — a `sourceRef` like `{"ordinal": 1, "locator": "..."}` is itself a
  // candidate. Every such fragment fails `Proposal.safeParse` for a reason
  // that has nothing to do with the real answer (typically a missing
  // `stance` enum), and overwriting `reason` on each iteration lets the last
  // nested fragment's unrelated complaint bury the outermost object's actual
  // problem — the outermost object is the one that was meant to be the
  // answer, so its reason is the one worth keeping.
  let reason: string | undefined;
  for (const candidate of candidates) {
    const parsed = Proposal.safeParse(candidate);
    if (!parsed.success) {
      reason ??= parsed.error.issues[0]?.message;
      continue;
    }

    const problems = proposalProblems(parsed.data, reading, catalogue);
    if (problems.length > 0) {
      const first = problems[0];
      return { status: 'unproposable', reason: `${first?.kind}: ${first?.detail}` };
    }

    return { status: 'proposed', proposal: parsed.data };
  }

  return { status: 'unproposable', reason: reason ?? 'schema mismatch' };
}

/** Every balanced JSON object in a response that may be wrapped in prose or a fence. */
function extractJsonObjects(raw: string): unknown[] {
  const text = raw.replace(/```(?:json)?/g, '');
  const found: unknown[] = [];

  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            found.push(JSON.parse(text.slice(start, i + 1)));
          } catch {
            // Not valid alone; a later brace may still open a valid object.
          }
          break;
        }
      }
    }
  }
  return found;
}
