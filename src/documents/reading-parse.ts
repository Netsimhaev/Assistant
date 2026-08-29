/**
 * Turning what the model said into a `Reading`, or into a stated reason why it
 * is not one (spec §3, §7).
 *
 * The shape of this module mirrors `parsePlan` (`src/sdk/planner.ts`): a
 * balanced-brace scan that tolerates prose and fenced blocks, zod for the
 * shape, and a separate structural pass for what a schema cannot express. The
 * scanner is written here rather than imported — it is private to `planner.ts`,
 * and the two callers answer to different prompts and are allowed to diverge.
 *
 * Nothing here throws on bad model output. A response that is not a reading is
 * a result to record, exactly as `ingestDocument` records a rejected document
 * instead of throwing at its caller.
 */

import { Reading } from '../domain/reading.js';

export type ParseOutcome =
  | { status: 'read'; reading: Reading }
  | { status: 'unreadable'; reason: string };

export type ReadingProblem = {
  kind: 'unknown_source';
  ordinal: number;
  /** Which list the bad citation appeared in, so the reason names a place. */
  where: 'finding' | 'intent';
};

/**
 * Citation integrity: the check zod cannot do, because it needs to know what
 * the reader was actually shown.
 *
 * A reading that attributes a claim to a part of the document that was not in
 * the brief is not a report about that document. This is the same class of
 * control as `planProblems` — the schema says the field is a number, and this
 * says the number addresses something real.
 *
 * `includedOrdinals` and **not** the artefact array. The two differ whenever
 * the total-brief ceiling drops a part (`renderReadingBrief`), and it is the
 * difference that matters: a citation to a part cut out of the brief is a
 * claim about text the model never saw, which is precisely the fabrication
 * this check exists to catch. Passing every artefact here would accept it.
 */
export function readingProblems(
  reading: Reading,
  includedOrdinals: readonly number[],
): ReadingProblem[] {
  const known = new Set(includedOrdinals);
  const problems: ReadingProblem[] = [];

  for (const finding of reading.findings) {
    if (!known.has(finding.sourceRef.ordinal)) {
      problems.push({ kind: 'unknown_source', ordinal: finding.sourceRef.ordinal, where: 'finding' });
    }
  }
  for (const intent of reading.intents) {
    if (!known.has(intent.sourceRef.ordinal)) {
      problems.push({ kind: 'unknown_source', ordinal: intent.sourceRef.ordinal, where: 'intent' });
    }
  }
  return problems;
}

export function parseReading(
  raw: string,
  includedOrdinals: readonly number[],
): ParseOutcome {
  const candidates = extractJsonObjects(raw);
  if (candidates.length === 0) {
    return { status: 'unreadable', reason: 'no JSON object in the response' };
  }

  // Every candidate is tried. A response that opens with an illustrative
  // object and then gives the real reading would otherwise be judged on the
  // example — the same reasoning as `parsePlan`.
  let reason = 'schema mismatch';
  for (const candidate of candidates) {
    const parsed = Reading.safeParse(candidate);
    if (!parsed.success) {
      reason = parsed.error.issues[0]?.message ?? reason;
      continue;
    }

    const problems = readingProblems(parsed.data, includedOrdinals);
    if (problems.length > 0) {
      // A well-formed reading with a fabricated citation is a real answer to
      // report, not something to keep looking past.
      const first = problems[0];
      return {
        status: 'unreadable',
        reason: `citation to a part that does not exist: ordinal ${first?.ordinal} in a ${first?.where}`,
      };
    }

    return { status: 'read', reading: parsed.data };
  }

  return { status: 'unreadable', reason };
}

/**
 * Every balanced JSON object in a response that may be wrapped in prose or a
 * fenced block.
 *
 * Balanced scanning rather than first `{` to last `}`: across two objects that
 * span is not valid JSON at all.
 */
function extractJsonObjects(raw: string): unknown[] {
  const text = raw.replace(/```(?:json)?/g, '');
  const found: unknown[] = [];

  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            found.push(JSON.parse(text.slice(start, i + 1)));
          } catch {
            // Not valid on its own; the next opening brace may still be.
          }
          break;
        }
      }
    }
  }
  return found;
}
