/**
 * Turning what the model said into a `Reading`, or into a stated reason why it
 * is not one (spec §3, §7).
 *
 * The shape of this module mirrors `parsePlan` (`src/sdk/planner.ts`): a
 * balanced-brace scan that tolerates prose and fenced blocks, zod for the
 * shape, and a separate structural pass for what a schema cannot express. The
 * scan itself (`extractJsonObjects`) is shared from `src/util/json-extract.ts`
 * — it was a private, byte-identical copy in this file, `proposal-parse.ts`
 * and `planner.ts` before that; the scan is prompt-agnostic (it only finds
 * balanced JSON objects in text), so sharing it does not stop this module's
 * own interpretation of what it finds from diverging from the others'.
 *
 * Nothing here throws on bad model output. A response that is not a reading is
 * a result to record, exactly as `ingestDocument` records a rejected document
 * instead of throwing at its caller.
 */

import { Reading } from '../domain/reading.js';
import { extractJsonObjects } from '../util/json-extract.js';

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
  //
  // Keep the first candidate's complaint, not the last. `extractJsonObjects`
  // yields the outermost object first and then every object nested inside it
  // — a `sourceRef` like `{"ordinal": 1, "locator": "..."}` is itself a
  // candidate, and it is the ordinary case here, not an exotic one. Every
  // such fragment fails `Reading.safeParse` for a reason that has nothing to
  // do with the real answer, and overwriting `reason` on each iteration lets
  // the last nested fragment's unrelated complaint bury the outermost
  // object's actual problem — the outermost object is the one that was meant
  // to be the answer, so its reason is the one worth keeping.
  let reason: string | undefined;
  for (const candidate of candidates) {
    const parsed = Reading.safeParse(candidate);
    if (!parsed.success) {
      reason ??= parsed.error.issues[0]?.message;
      continue;
    }

    const problems = readingProblems(parsed.data, includedOrdinals);
    if (problems.length > 0) {
      // A well-formed reading with a fabricated citation is a real answer to
      // report, not something to keep looking past.
      const first = problems[0];
      return {
        status: 'unreadable',
        reason: `citation to a part not included in the brief: ordinal ${first?.ordinal} in a ${first?.where}`,
      };
    }

    return { status: 'read', reading: parsed.data };
  }

  return { status: 'unreadable', reason: reason ?? 'schema mismatch' };
}
