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
   */
  answerTruncated: z.boolean(),
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
     ON CONFLICT (business_id, job_id) DO UPDATE SET verdict = EXCLUDED.verdict`,
    [businessId, jobId, JSON.stringify(verdict)],
  );
}

/** The current verdict for a job, or `null` if none has been saved yet. */
export async function loadVerdict(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<Verdict | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<VerdictRow>(
    `SELECT verdict FROM verification_verdicts WHERE business_id = $1 AND job_id = $2`,
    [businessId, jobId],
  );
  const row = rows[0];
  return row ? toVerdict(row) : null;
}
