/**
 * The stored answer to "does this draft meet the criteria a plan declared
 * before it was allowed to send" — one row per job, holding the verdict as
 * it stands right now.
 *
 * `verification_verdicts` (migration 028) is already wired into the eraser
 * (`erasure-plan.ts`, `erasure.ts`) — this module only adds the schema and
 * the two functions that write and read it.
 */
import { z } from 'zod';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import type { Queryable } from '../db/pool.js';

export const Verdict = z.object({
  criteria: z
    .array(
      z.object({
        id: z.string().min(1),
        statement: z.string().min(1),
        severity: z.enum(['must', 'should']),
        passed: z.boolean(),
        detail: z.string(),
      }),
    )
    .min(1),
  ungroundedNumbers: z.array(z.string()),
  /**
   * Whether the answer `gov.verify` received from `know.reader` had to be cut
   * before it reached the judge (`MAX_ANSWER_CHARS`, `src/sdk/gov-verify.ts`).
   * Computed and written by CODE, never asked of the model: the in-prompt
   * truncation notice sits inside the untrusted answer's own fence, so a
   * hostile answer could otherwise forge it (claim a cut that never happened)
   * or omit it (a real cut, unremarked). Without a field the code controls,
   * outside the fence, an owner reading a verdict later has no way to tell a
   * genuine cut from a claimed one — or to know the judge saw less than the
   * whole answer at all.
   *
   * `.default(false)` — added a round after this field's own first commit,
   * for a reason worth stating so the next field added here does not repeat
   * it: `toVerdict` calls `Verdict.parse`, not `safeParse`, so a bare
   * `z.boolean()` here made `loadVerdict` THROW on any row a version of the
   * code before this field existed had already saved. The blast radius was
   * small only because nothing downstream reads a verdict back yet — that is
   * exactly why it is cheap to fix now and would have been expensive to
   * discover later, once something did.
   */
  answerTruncated: z.boolean().default(false),
  /**
   * Whether `draftText` had to be cut before it reached the judge
   * (`MAX_DRAFT_CHARS`). Added a round after `draftText` itself gained the
   * answer's fence and cap (round 3) but not this equivalent — a 4,500
   * character draft was silently cut to 4,000 with nothing recording it, and
   * a saved verdict could read `passed: true` with no way to tell the judge
   * never saw the tail. `ungroundedNumbers` is unaffected by this cut (it
   * runs on the FULL draft before any truncation — see `verifyDraft`); only
   * the model's own judgment is blind to whatever this flags. Same
   * `.default(false)` reasoning as `answerTruncated`.
   */
  draftTruncated: z.boolean().default(false),
  /**
   * Whether `question`, `answer` or `draftText` contained something shaped
   * like this module's own fence markers — computed by CODE from the raw
   * input (`wasFenceForgeryAttempted`, `src/sdk/gov-verify.ts`), independent
   * of whatever a particular call's random nonce turned out to be. An
   * attempt is worth an owner's attention regardless of whether the nonce
   * that call actually used made it impossible to succeed.
   *
   * **`.optional()`, not `.default(false)` — unlike the two truncation
   * flags above, and deliberately so.** This is a security signal, and
   * `.default(false)` would make "we cannot read this field on an old row"
   * mean "checked, and clean" — the exact inversion of this project's own
   * rule that a value which could not be read is never a permitting one
   * (`amount_unreadable`, an unknown data class scored most severe, and so
   * on throughout this codebase). `.optional()` lets a future reader tell
   * "false: checked, nothing found" apart from "absent: never checked at
   * all" — a distinction that costs nothing to keep today, before any reader
   * exists, and would be expensive to retrofit once one does.
   */
  fenceForgeryDetected: z.boolean().optional(),
});
export type Verdict = z.infer<typeof Verdict>;

interface VerdictRow {
  verdict: unknown;
}

function toVerdict(row: VerdictRow): Verdict {
  return Verdict.parse(row.verdict);
}

/**
 * Store the verdict for a job, replacing any earlier one on the same job.
 *
 * `ON CONFLICT (business_id, job_id) DO UPDATE`, not a plain INSERT: a
 * verdict is a claim about what is true of the draft *now*, not a historical
 * record of every check ever run — a plan that gets re-verified after an
 * edit must overwrite the stale verdict, not accumulate a second row a
 * reader could confuse for the current one.
 */
export async function saveVerdict(
  jobId: string,
  verdict: Verdict,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  await db.query(
    `INSERT INTO verification_verdicts (business_id, job_id, verdict)
     VALUES ($1, $2, $3)
     ON CONFLICT (business_id, job_id)
     DO UPDATE SET verdict = EXCLUDED.verdict, not_judged_reason = NULL`,
    [businessId, jobId, JSON.stringify(verdict)],
  );
}

/**
 * The current verdict for a job, or `null` if none has been saved yet — which
 * now also covers a not-judged row: `verdict IS NOT NULL` excludes it, so a
 * caller that only wants the real verdict never has to know the sibling
 * column exists. Use `loadVerificationOutcome` to see all three states.
 */
export async function loadVerdict(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<Verdict | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<VerdictRow>(
    `SELECT verdict FROM verification_verdicts
      WHERE business_id = $1 AND job_id = $2 AND verdict IS NOT NULL`,
    [businessId, jobId],
  );
  const row = rows[0];
  return row ? toVerdict(row) : null;
}

/**
 * Why a verification produced no judgment. Both values come from
 * `DelegationOutcome` (`src/domain/envelope.ts`) — the helper failed, or it
 * never answered inside the envelope's deadline. `succeeded` is deliberately
 * absent: a delegation that succeeded produces a real `Verdict`, so there is
 * no third value this enum could carry without meaning "judged after all".
 */
export const NotJudgedReason = z.enum(['failed', 'timeout']);
export type NotJudgedReason = z.infer<typeof NotJudgedReason>;

/**
 * What verification has to say about a job, in the three states the card
 * distinguishes. `null` from `loadVerificationOutcome` is the fourth and it is
 * the important one: no row means the check is still running, and it means
 * ONLY that, because verification is attempted on every card the conductor
 * raises. Were it selective, absence would also cover "nobody tried".
 */
export type VerificationOutcome =
  | { status: 'judged'; verdict: Verdict }
  | { status: 'not_judged'; reason: NotJudgedReason };

/**
 * Record that verification was attempted for a job and did not produce a
 * verdict. `ON CONFLICT ... DO UPDATE` clears `verdict` the same way
 * `saveVerdict` clears `not_judged_reason` — each writer owns clearing the
 * other's column, because the CHECK constraint (`verification_verdicts_one_shape`)
 * rejects a row that claims both at once.
 */
export async function saveNotJudged(
  jobId: string,
  reason: NotJudgedReason,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  await db.query(
    `INSERT INTO verification_verdicts (business_id, job_id, verdict, not_judged_reason)
     VALUES ($1, $2, NULL, $3)
     ON CONFLICT (business_id, job_id)
     DO UPDATE SET verdict = NULL, not_judged_reason = EXCLUDED.not_judged_reason`,
    [businessId, jobId, reason],
  );
}

interface OutcomeRow {
  verdict: unknown;
  not_judged_reason: string | null;
}

/** The full three-state outcome for a job, or `null` if verification has not written anything yet. */
export async function loadVerificationOutcome(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<VerificationOutcome | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<OutcomeRow>(
    `SELECT verdict, not_judged_reason FROM verification_verdicts
      WHERE business_id = $1 AND job_id = $2`,
    [businessId, jobId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  if (row.not_judged_reason !== null) {
    // The DB CHECK already constrains this column, so a value outside the enum
    // means the constraint was dropped or bypassed. Parsed rather than cast for
    // the same reason every other read here is: a value we could not read is
    // not a value we report.
    return { status: 'not_judged', reason: NotJudgedReason.parse(row.not_judged_reason) };
  }
  return { status: 'judged', verdict: Verdict.parse(row.verdict) };
}
