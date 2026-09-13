/**
 * Carrying out an erasure the owner confirmed.
 *
 * Deletes exactly what the plan lists and resolves nothing of its own. A row
 * the plan did not name is not deleted, however right it might have been to
 * delete it — that is what makes the preview the owner approved the truth
 * about what happened (spec §4.4).
 *
 * **Order: the database first, then the files.** A file deletion cannot be
 * rolled back and is not part of the transaction. If the file goes first and
 * the transaction then fails, a document row points at nothing. If the
 * database goes first and a file deletion fails, an orphan file nobody
 * references survives on disk — reported loudly, and cleanable. Of the two
 * failures only the second can be repaired (spec §7).
 *
 * **Statement order inside the transaction is also load-bearing, not just
 * atomicity.** `documents` cascades onto `document_artifacts` and
 * `document_readings`, which in turn cascades onto `proposals`. If
 * `document_readings` were deleted before the explicit `proposals` delete
 * runs, the cascade would remove those proposal rows first and the explicit
 * statement would report zero affected rows for a table that really did lose
 * a proposal — the same "preview disagrees with reality" defect fixed in the
 * resolver (`erasure-plan.ts`, spec §4.4/C1), reintroduced one layer down if
 * a cascade beats an explicit delete to the row. Every explicit delete here
 * therefore runs on a leaf before the parent whose cascade could otherwise
 * pre-empt it: `proposals` before `document_readings`, and both before
 * `documents`.
 */
import { unlink } from 'node:fs/promises';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import type { ErasureItem, ErasurePlan } from './erasure-plan.js';
import { LIVE_PHASES } from './erasure-plan.js';

/** Thrown when a plan carrying a refusal is handed to the executor, or when a
 * job the plan touches turns out to be live by the time the transaction
 * actually starts (see the liveness re-check below). */
export class ErasureRefusedError extends Error {}

export interface ErasureOutcome {
  /** What was actually deleted or scrubbed, from the statements' own row
   * counts — never copied from the plan's preview, which can only say what
   * was true when the preview was built. */
  deleted: ErasureItem[];
  filesRemoved: number;
  /** Paths the database no longer references and the disk still holds. */
  filesFailed: string[];
}

/**
 * Thrown when the database and file deletions have already committed but the
 * audit entry recording the erasure failed to append.
 *
 * By the time this can be thrown, the erasure is unconditionally done and
 * cannot be undone — the transaction committed and every file `unlink` has
 * already been attempted. A raw throw here would leave the caller unable to
 * tell "nothing happened" from "everything happened, unlogged", and would
 * lose `outcome` (`filesFailed` in particular) along with it.
 *
 * Same shape as `KillSwitchAuditUnrecordedError`
 * (`src/governance/killswitch.ts`) and for the same reason: once the
 * irreversible half of an action has already committed, the only honest
 * failure left is "it happened, and the record of it is missing" — never
 * "it didn't happen" and never silence. `outcome` travels on the error so a
 * caller can still report exactly what was erased even though the log entry
 * describing it did not survive.
 */
export class ErasureAuditUnrecordedError extends Error {
  readonly erased = true as const;
  readonly outcome: ErasureOutcome;

  constructor(outcome: ErasureOutcome, cause: unknown) {
    super(
      `an erasure completed (deleted/scrubbed rows and ${outcome.filesRemoved} file(s)) ` +
        `but the audit entry recording it failed to write. The erasure IS done; the ` +
        `record of it is missing and must be reconstructed manually.`,
      { cause },
    );
    this.name = 'ErasureAuditUnrecordedError';
    this.outcome = outcome;
  }
}

export async function executeErasure(
  plan: ErasurePlan,
  options: { businessId?: string } = {},
): Promise<ErasureOutcome> {
  const businessId = options.businessId ?? config.businessId;

  if (plan.refusals.length > 0) {
    throw new ErasureRefusedError(plan.refusals.map((r) => r.detail).join(' · '));
  }

  const { jobIds, documentIds, memoryIds } = plan;
  const client = await getPool().connect();
  const results: ErasureItem[] = [];
  let txError: unknown;
  try {
    await client.query('BEGIN');

    // Re-check liveness under a row lock. The plan-time refusal in
    // `buildErasurePlan` reads `jobs.phase` with no lock and is never read
    // again — a job sitting in `followup` when the preview was built, which
    // the scheduler wakes to `execute` before the owner confirms, would
    // otherwise have its `job_plans`, `approval_requests` and
    // `boss_instructions` deleted mid-run. `FOR UPDATE` also serialises two
    // concurrent erasures against the same jobs, which nothing else does.
    if (jobIds.length > 0) {
      const { rows: lockedJobs } = await client.query<{ job_id: string; phase: string }>(
        'SELECT job_id, phase FROM jobs WHERE business_id = $1 AND job_id = ANY ($2) FOR UPDATE',
        [businessId, jobIds],
      );
      const stillLive = lockedJobs.filter((row) => LIVE_PHASES.includes(row.phase));
      if (stillLive.length > 0) {
        throw new ErasureRefusedError(
          stillLive
            .map(
              (row) =>
                `משימה ${row.job_id} עברה למצב ${row.phase} מאז שהתצוגה המקדימה הוכנה; המחיקה בוטלה.`,
            )
            .join(' · '),
        );
      }
    }

    const del = async (table: string, sql: string, params: unknown[]): Promise<void> => {
      const { rowCount } = await client.query(sql, params);
      results.push({ table, action: 'delete', count: rowCount ?? 0 });
    };
    const scrub = async (table: string, sql: string, params: unknown[]): Promise<void> => {
      const { rowCount } = await client.query(sql, params);
      results.push({ table, action: 'scrub', count: rowCount ?? 0 });
    };

    // Deleted: rows whose whole existence is the content. `proposals` runs
    // before `document_readings` — see the docblock above — so the explicit
    // delete, not the reading's cascade, is what removes it and what gets
    // credited with removing it.
    await del('memories', 'DELETE FROM memories WHERE business_id=$1 AND memory_id = ANY($2)', [businessId, memoryIds]);
    await del('proposals', 'DELETE FROM proposals WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    await del('document_readings', 'DELETE FROM document_readings WHERE business_id=$1 AND document_id = ANY($2)', [businessId, documentIds]);
    await del('document_artifacts', 'DELETE FROM document_artifacts WHERE business_id=$1 AND document_id = ANY($2)', [businessId, documentIds]);
    await del('approval_requests', 'DELETE FROM approval_requests WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    await del('boss_instructions', 'DELETE FROM boss_instructions WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    await del('job_plans', 'DELETE FROM job_plans WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    await del('job_authorizations', 'DELETE FROM job_authorizations WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    await del('documents', 'DELETE FROM documents WHERE business_id=$1 AND document_id = ANY($2)', [businessId, documentIds]);

    // Scrubbed: rows that carry a content field and must keep existing, so
    // audit rows go on pointing at jobs that are really there. The `WHERE`
    // clauses mirror `countItems` in `erasure-plan.ts` exactly, so a
    // statement's real row count agrees with what the preview counted.
    await scrub('jobs', 'UPDATE jobs SET title = NULL WHERE business_id=$1 AND job_id = ANY($2) AND title IS NOT NULL', [businessId, jobIds]);
    await scrub('job_steps', `UPDATE job_steps SET reason = 'נמחק בהוראת הבעלים' WHERE job_id = ANY($1)`, [jobIds]);
    await scrub('job_step_results', 'UPDATE job_step_results SET external_id = NULL WHERE business_id=$1 AND job_id = ANY($2) AND external_id IS NOT NULL', [businessId, jobIds]);

    await client.query('COMMIT');
  } catch (err) {
    txError = err;
    try {
      await client.query('ROLLBACK');
    } catch {
      // Rollback itself failing means the connection is already broken; the
      // error that caused the rollback is what is worth propagating, not the
      // secondary failure of trying to undo it.
    }
    throw err;
  } finally {
    // A poisoned connection (anything reached the `catch` above) is
    // destroyed rather than returned to the pool for the next caller to
    // inherit; a clean run releases normally. `pg`'s `release` only wants
    // `Error | boolean`, and what was caught here is `unknown` and not
    // necessarily an `Error`, so it is collapsed to a flag rather than
    // passed through.
    client.release(txError !== undefined);
  }

  // Only now the disk.
  let filesRemoved = 0;
  const filesFailed: string[] = [];
  for (const path of plan.filePaths) {
    try {
      await unlink(path);
      filesRemoved += 1;
    } catch (err) {
      // A file that was already gone is not a failure: the goal was that it
      // not be there, and it is not.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      filesFailed.push(path);
    }
  }

  const outcome: ErasureOutcome = { deleted: results, filesRemoved, filesFailed };

  // Real counts, not the preview's: the whole point of this row is to
  // survive as the one record of what happened, and what happened is what
  // the statements above actually reported.
  const total = results.reduce((sum, item) => sum + item.count, 0);

  try {
    await appendAudit(
      {
        actor: 'human',
        kind: 'erasure',
        charterVersion: 'n/a',
        provenance: 'boss',
        // Counts only. The anchor's KIND is safe to record; its value is the
        // identity the owner asked to remove, and naming it here would defeat
        // the whole operation.
        inputHash: canonicalHash({ anchorKind: plan.anchor.kind, total }),
        artifacts: [],
        costMinor: null,
        tokens: null,
        reason:
          `מחיקה בהוראת הבעלים · עוגן מסוג ${plan.anchor.kind} · ` +
          `${total} פריטים · ${plan.filePaths.length} קבצים · ` +
          `${plan.excluded.length} נשמרו לפי הוראה קודמת` +
          (filesFailed.length > 0 ? ` · ${filesFailed.length} קבצים לא נמחקו מהדיסק` : ''),
      },
      { businessId },
    );
  } catch (err) {
    throw new ErasureAuditUnrecordedError(outcome, err);
  }

  return outcome;
}
