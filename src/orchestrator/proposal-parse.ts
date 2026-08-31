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
import { classifiedToolNames, classifyAction } from '../policy/classify.js';
import type { CatalogueEntry } from './catalogue.js';

export type ProposalProblem = {
  kind:
    | 'act_without_action'
    | 'action_on_passive_stance'
    | 'ask_without_question'
    | 'reason_cites_unknown_finding'
    | 'tool_not_in_catalogue'
    | 'action_class_mismatch'
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

    // Advisory, but a mismatch means the planner intended something other than
    // what will happen — the same rule `Plan` already holds for its steps.
    const actual = classifyAction(action.toolName);
    if (action.expectedActionClass !== null && actual !== null && action.expectedActionClass !== actual) {
      problems.push({
        kind: 'action_class_mismatch',
        detail: `תוכנן ${action.expectedActionClass}, יסווג ${actual}`,
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

  let reason = 'schema mismatch';
  for (const candidate of candidates) {
    const parsed = Proposal.safeParse(candidate);
    if (!parsed.success) {
      reason = parsed.error.issues[0]?.message ?? reason;
      continue;
    }

    const problems = proposalProblems(parsed.data, reading, catalogue);
    if (problems.length > 0) {
      const first = problems[0];
      return { status: 'unproposable', reason: `${first?.kind}: ${first?.detail}` };
    }

    return { status: 'proposed', proposal: parsed.data };
  }

  return { status: 'unproposable', reason };
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
