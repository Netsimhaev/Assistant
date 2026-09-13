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
 */
import { unlink } from 'node:fs/promises';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import type { ErasureItem, ErasurePlan } from './erasure-plan.js';

/** Thrown when a plan carrying a refusal is handed to the executor. */
export class ErasureRefusedError extends Error {}

export interface ErasureOutcome {
  deleted: ErasureItem[];
  filesRemoved: number;
  /** Paths the database no longer references and the disk still holds. */
  filesFailed: string[];
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
  try {
    await client.query('BEGIN');

    // Deleted: rows whose whole existence is the content.
    await client.query('DELETE FROM memories WHERE business_id=$1 AND memory_id = ANY($2)', [businessId, memoryIds]);
    await client.query('DELETE FROM document_artifacts WHERE business_id=$1 AND document_id = ANY($2)', [businessId, documentIds]);
    await client.query('DELETE FROM document_readings WHERE business_id=$1 AND document_id = ANY($2)', [businessId, documentIds]);
    await client.query('DELETE FROM proposals WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    await client.query('DELETE FROM approval_requests WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    await client.query('DELETE FROM boss_instructions WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    await client.query('DELETE FROM job_plans WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    await client.query('DELETE FROM job_authorizations WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    await client.query('DELETE FROM documents WHERE business_id=$1 AND document_id = ANY($2)', [businessId, documentIds]);

    // Scrubbed: rows that carry a content field and must keep existing, so
    // audit rows go on pointing at jobs that are really there.
    await client.query('UPDATE jobs SET title = NULL WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    await client.query(`UPDATE job_steps SET reason = 'נמחק בהוראת הבעלים' WHERE job_id = ANY($1)`, [jobIds]);
    await client.query('UPDATE job_step_results SET external_id = NULL WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
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

  const total = plan.items.reduce((sum, item) => sum + item.count, 0);
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

  return { deleted: plan.items, filesRemoved, filesFailed };
}
