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
import type { ErasureItem, ErasurePlan, ErasureRefusal } from './erasure-plan.js';
import {
  ACTION_UPDATES_ERASED_PREDICATE,
  AGENT_ENVELOPES_ERASED_PREDICATE,
  APPROVAL_REQUESTS_ERASED_PREDICATE,
  APPROVAL_REQUESTS_SCRUBBED_PREDICATE,
  APPROVAL_REQUESTS_SCRUB_SET,
  DIGESTS_ERASED_PREDICATE,
  JOBS_SCRUBBED_PREDICATE,
  JOBS_SCRUB_SET,
  LIVE_PHASES,
  MAIL_INVOICES_ERASED_PREDICATE,
  MAIL_MESSAGES_ERASED_PREDICATE,
  PROPOSALS_ERASED_PREDICATE,
  STRANDED_PARENT_PREDICATE,
  VERIFICATION_VERDICTS_ERASED_PREDICATE,
  WHATSAPP_MESSAGES_ERASED_PREDICATE,
  approvalRequestParams,
  whatsappMessageParams,
} from './erasure-plan.js';

/** Thrown when a plan carrying a refusal is handed to the executor, or when a
 * job the plan touches turns out to be live by the time the transaction
 * actually starts (see the liveness re-check below), or when a document the
 * plan names was signed between the preview and the confirm.
 *
 * `kind` carries which of spec §7.1's two refusals this is, so the screen
 * re-shows it as the refusal it actually is rather than labelling every
 * execution-time refusal a live job. */
export class ErasureRefusedError extends Error {
  readonly kind: ErasureRefusal['kind'];

  constructor(message: string, kind: ErasureRefusal['kind'] = 'live_job') {
    super(message);
    this.name = 'ErasureRefusedError';
    this.kind = kind;
  }
}

/**
 * Postgres' foreign-key violation. `signatures.document_id` is `ON DELETE
 * RESTRICT` since migration 020, and that constraint — not the plan-time
 * read, which happens before the owner clicks — is the authoritative answer
 * to "is this document signed". A signature inserted in between therefore
 * surfaces here and nowhere else.
 */
const FOREIGN_KEY_VIOLATION = '23503';
const SIGNATURE_DOCUMENT_FK = 'signatures_document_id_fkey';

function isSignatureRestriction(err: unknown): boolean {
  const candidate = err as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === FOREIGN_KEY_VIOLATION && candidate.constraint === SIGNATURE_DOCUMENT_FK
  );
}

export interface ErasureOutcome {
  /** What was actually deleted or scrubbed, from the statements' own row
   * counts — never copied from the plan's preview, which can only say what
   * was true when the preview was built. */
  deleted: ErasureItem[];
  /** Files this run actually unlinked — never a file that was already absent. */
  filesRemoved: number;
  /**
   * Files the plan named that were not on disk when the unlink ran.
   *
   * Tolerated, not failed: the goal was that they not be there, and they are
   * not. Counted separately because being *indistinguishable* from a file we
   * deleted is what let a run that resolved every path wrongly — and therefore
   * deleted nothing at all — report itself as clean. A run where every file is
   * "already gone" is an anomaly, and the screen can only say so if this
   * number exists.
   */
  filesAlreadyGone: string[];
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
    // The kind travels with the message so the screen re-shows the refusal it
    // actually is; the first one is the one the sentence leads with.
    throw new ErasureRefusedError(
      plan.refusals.map((r) => r.detail).join(' · '),
      plan.refusals[0]?.kind ?? 'live_job',
    );
  }

  const { jobIds, documentIds, memoryIds, digestIds, mailIds } = plan;
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
    //
    // The same locked read also identifies STRANDED parents (fix round 2,
    // item 1): a job in `followup`, parked on its own `agent_envelopes` row,
    // which `AGENT_ENVELOPES_ERASED_PREDICATE` is about to delete out from
    // under it. `stranded` is a computed COLUMN on this same `SELECT`,
    // interpolating `STRANDED_PARENT_PREDICATE` verbatim (fix round 3, item
    // 2) — the identical text `countItems` uses for the preview, evaluated
    // once here, before any delete runs, never re-queried against a table a
    // later statement in this same transaction is about to change.
    const stranded: Array<{ jobId: string; envelopeId: string; phase: string }> = [];
    if (jobIds.length > 0) {
      const { rows: lockedJobs } = await client.query<{
        job_id: string;
        phase: string;
        awaiting_envelope_id: string | null;
        stranded: boolean;
      }>(
        `SELECT job_id, phase, awaiting_envelope_id, (${STRANDED_PARENT_PREDICATE}) AS stranded
           FROM jobs WHERE business_id = $1 AND job_id = ANY ($2) FOR UPDATE`,
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
      for (const row of lockedJobs) {
        // `row.awaiting_envelope_id !== null` is provably true whenever
        // `row.stranded` is, per the predicate itself — checked again here
        // only to satisfy the type system without an unsafe assertion, not
        // because it can disagree.
        if (row.stranded && row.awaiting_envelope_id !== null) {
          stranded.push({ jobId: row.job_id, envelopeId: row.awaiting_envelope_id, phase: row.phase });
        }
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
    // credited with removing it. The predicate is `PROPOSALS_ERASED_PREDICATE`
    // itself, the same constant `countItems` interpolates, with the same
    // three parameters in the same order: the preview and the destruction
    // cannot drift here because there is only one of them.
    await del('memories', 'DELETE FROM memories WHERE business_id=$1 AND memory_id = ANY($2)', [businessId, memoryIds]);
    // `digests` has no job id and no document id — see `erasure-plan.ts`'s
    // header for why it is discovered by its own `body` alone. Same
    // predicate, same parameters, as `countItems` there; placed beside
    // `memories` because neither table's deletion depends on the
    // `proposals`-before-`document_readings`-before-`documents` ordering
    // below.
    await del(
      'digests',
      `DELETE FROM digests WHERE ${DIGESTS_ERASED_PREDICATE}`,
      [businessId, digestIds],
    );
    await del(
      'proposals',
      `DELETE FROM proposals WHERE ${PROPOSALS_ERASED_PREDICATE}`,
      [businessId, jobIds, documentIds],
    );
    await del('document_readings', 'DELETE FROM document_readings WHERE business_id=$1 AND document_id = ANY($2)', [businessId, documentIds]);
    await del('document_artifacts', 'DELETE FROM document_artifacts WHERE business_id=$1 AND document_id = ANY($2)', [businessId, documentIds]);
    // The same constant and the same five parameter VALUES the preview
    // counted — derived from `plan.anchor` by the plan builder's own
    // function, never rebuilt here. An orphan card (`job_id IS NULL`) holds
    // the address and the message body and closes over to no job, so
    // `job_id = ANY($2)` alone left it listed nowhere and deleted nowhere.
    await del(
      'approval_requests',
      `DELETE FROM approval_requests WHERE ${APPROVAL_REQUESTS_ERASED_PREDICATE}`,
      approvalRequestParams(businessId, jobIds, plan.anchor),
    );
    await del('boss_instructions', 'DELETE FROM boss_instructions WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    // `whatsapp_messages` can hold the counterparty's own number and message
    // text with no job at all (an unclaimed inbound message, or one from a
    // number the business never opened a job for) — see
    // `WHATSAPP_MESSAGES_ERASED_PREDICATE`'s docblock in `erasure-plan.ts` for
    // why that is three arms rather than `job_id = ANY($2)` alone. Same
    // predicate, same parameters, as `countItems` there.
    await del(
      'whatsapp_messages',
      `DELETE FROM whatsapp_messages WHERE ${WHATSAPP_MESSAGES_ERASED_PREDICATE}`,
      whatsappMessageParams(businessId, jobIds, plan.anchor),
    );
    // The mailbox (migrations 042/044). `mail_invoices` FIRST: its `mail_id`
    // cascades from `mail_messages`, and a cascade that beat this statement
    // to the row would leave it reporting zero for a table that lost rows —
    // the `proposals`-before-`document_readings` rule from this file's
    // header, one table pair over. Neither has a foreign key to `documents`,
    // so their place relative to the `documents` delete below is free. Same
    // predicates, same parameters, as `countItems` in `erasure-plan.ts`.
    await del(
      'mail_invoices',
      `DELETE FROM mail_invoices WHERE ${MAIL_INVOICES_ERASED_PREDICATE}`,
      [businessId, mailIds, documentIds],
    );
    await del(
      'mail_messages',
      `DELETE FROM mail_messages WHERE ${MAIL_MESSAGES_ERASED_PREDICATE}`,
      [businessId, mailIds],
    );
    // `autonomy_marks.note` is owner-written content about a corrected step
    // and is not restricted to naming the counterparty the step happened to
    // be addressed to — see `erasure-plan.ts`'s header for why this is the
    // one migration-026 table wired in here (its two siblings are not) and
    // why `buildErasurePlan` also searches `note` itself to discover a job
    // that has no other tie to the contact. Same predicate, same parameters,
    // as `countItems` there.
    await del('autonomy_marks', 'DELETE FROM autonomy_marks WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    // Migration 047's record of what the owner was told about a performed
    // step. No foreign key, so no cascade to order against. Same predicate,
    // same parameters, as `countItems` in `erasure-plan.ts`.
    await del(
      'action_updates',
      `DELETE FROM action_updates WHERE ${ACTION_UPDATES_ERASED_PREDICATE}`,
      [businessId, jobIds],
    );
    await del('job_plans', 'DELETE FROM job_plans WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    await del('job_authorizations', 'DELETE FROM job_authorizations WHERE business_id=$1 AND job_id = ANY($2)', [businessId, jobIds]);
    // Migration 028's two tables. Neither carries a foreign key to `jobs` or
    // `documents` (both `parent_job_id`/`child_job_id` and `job_id` are plain
    // TEXT), so neither can be reached by a cascade from anything deleted
    // above or below — their placement here is not load-bearing the way
    // `proposals`-before-`document_readings` is, only grouped with the other
    // job-scoped delete-only tables for readability. Same predicates, same
    // parameters, as `countItems` in `erasure-plan.ts`.
    await del(
      'agent_envelopes',
      `DELETE FROM agent_envelopes WHERE ${AGENT_ENVELOPES_ERASED_PREDICATE}`,
      [businessId, jobIds],
    );
    await del(
      'verification_verdicts',
      `DELETE FROM verification_verdicts WHERE ${VERIFICATION_VERDICTS_ERASED_PREDICATE}`,
      [businessId, jobIds],
    );
    // The only statement that can be refused by the schema itself. A
    // signature added after the preview was built makes migration 020's
    // RESTRICT reject this delete; the transaction rolls back and nothing is
    // destroyed, which is right — but re-thrown raw it reached the owner as a
    // 500 instead of the sentence spec §7.1 wrote for this case. Translated,
    // not swallowed: it still aborts the erasure.
    try {
      await del('documents', 'DELETE FROM documents WHERE business_id=$1 AND document_id = ANY($2)', [businessId, documentIds]);
    } catch (err) {
      if (!isSignatureRestriction(err)) throw err;
      throw new ErasureRefusedError(
        'מסמך שהתוכנית מנתה נחתם מאז שהתצוגה המקדימה הוכנה; המחיקה בוטלה ולא נמחק דבר.',
        'signed_document',
      );
    }

    // Scrubbed: rows that carry a content field and must keep existing, so
    // audit rows go on pointing at jobs that are really there. The `WHERE`
    // clauses mirror `countItems` in `erasure-plan.ts` exactly, so a
    // statement's real row count agrees with what the preview counted.
    //
    // `approval_requests` is the one conditional row in spec §5.1.1: deleted
    // above unless a signature points at it, emptied and kept here when one
    // does. A signature attests to a human act performed THROUGH this
    // approval; destroying the approval leaves it pointing at nothing, the
    // same thing migration 020's RESTRICT already refuses one table over.
    await scrub(
      'approval_requests',
      `UPDATE approval_requests SET ${APPROVAL_REQUESTS_SCRUB_SET} WHERE ${APPROVAL_REQUESTS_SCRUBBED_PREDICATE}`,
      approvalRequestParams(businessId, jobIds, plan.anchor),
    );
    // `awaiting_envelope_id` is cleared alongside `title` on EVERY job in
    // `jobIds` — content hygiene only, not what resolves a stranded parent.
    // See `JOBS_SCRUBBED_PREDICATE`'s docblock in `erasure-plan.ts` for why
    // this alone is not enough, and the `fail` block below for what is.
    await scrub('jobs', `UPDATE jobs SET ${JOBS_SCRUB_SET} WHERE ${JOBS_SCRUBBED_PREDICATE}`, [businessId, jobIds]);
    await scrub('job_steps', `UPDATE job_steps SET reason = 'נמחק בהוראת הבעלים' WHERE job_id = ANY($1)`, [jobIds]);
    await scrub('job_step_results', 'UPDATE job_step_results SET external_id = NULL WHERE business_id=$1 AND job_id = ANY($2) AND external_id IS NOT NULL', [businessId, jobIds]);

    // Failed: a job PARKED on the very `agent_envelopes` row this transaction
    // just deleted. `stranded` was derived from the `FOR UPDATE` lock taken
    // above, before any delete ran — not re-queried now, per
    // `STRANDED_PARENT_PREDICATE`'s own docblock. `followup → failed` is a
    // legal move (`domain/job.ts`'s `LEGAL_TRANSITIONS`). This does not call
    // `transition()`: that function opens its OWN transaction and re-takes
    // `SELECT ... FOR UPDATE` on the same row, which would block forever on
    // the lock this transaction is already holding and has not committed —
    // and, separately, `transition()` commits independently, so a move made
    // through it would survive a rollback of the erasure itself. The update
    // and its `job_steps` row are written directly on `client` instead,
    // inside the same transaction that already holds the lock and that the
    // erasure's own rollback already covers.
    //
    // **`AND phase = 'followup'` is the legality guard, written into the SQL
    // rather than left to the JS filter above (fix round 3, item 1).** The
    // `stranded` array is already computed from a predicate that requires
    // `phase = 'followup'`, so today this WHERE clause is provably redundant
    // — but redundant is the point: if the JS side is ever widened (a second
    // stranding shape, a dropped phase check), this is the line that still
    // refuses to move a job whose phase was never actually `followup`, and
    // does so LOUDLY, as zero affected rows, rather than writing a
    // `job_steps.from_phase` that never happened. `wake_at = NULL` alongside
    // `phase`/`closed_at`, matching what `transition()` itself always
    // overwrites on every move (fix round 3, item 3) — harmless today only
    // because no current park sets both a pointer and a wake time, and this
    // statement should normalise the terminal row rather than rely on that
    // staying true.
    //
    // `RETURNING job_id` — not `stranded.map(...)` — is what actually gates
    // the `job_steps` insert below: a job the WHERE clause refused (because
    // its real phase was not `followup`, contradicting a widened JS filter)
    // must not receive a `job_steps` row claiming a transition that never
    // happened in `jobs` itself. Only fetch `job_id` because the SET clause
    // does not touch `from_phase` — the row's phase as OBSERVED at lock time
    // (`stranded`'s own `phase` field), not the literal `'followup'`, is what
    // is written to `job_steps.from_phase` for the rows this UPDATE actually
    // moved.
    //
    // Placed AFTER the `job_steps` reason-scrub above, deliberately: that
    // statement blanks every existing `job_steps.reason` for `job_id = ANY
    // ($1)`, and a row inserted before it would be caught by the same
    // `UPDATE` and lose the sentence below. Inserted after, this row is the
    // one line in a stranded job's history that says why it failed — the
    // (now-deleted) envelope's id, never the contact.
    const { rows: failedRows } = await client.query<{ job_id: string }>(
      `UPDATE jobs SET phase = 'failed', wake_at = NULL, closed_at = now(), updated_at = now()
        WHERE business_id = $1 AND job_id = ANY ($2) AND phase = 'followup'
        RETURNING job_id`,
      [businessId, stranded.map((s) => s.jobId)],
    );
    results.push({ table: 'jobs', action: 'fail', count: failedRows.length });

    const actuallyFailed = new Set(failedRows.map((row) => row.job_id));
    for (const { jobId, envelopeId, phase } of stranded) {
      if (!actuallyFailed.has(jobId)) continue;
      await client.query(
        `INSERT INTO job_steps (job_id, from_phase, to_phase, actor, envelope_id, reason)
         VALUES ($1, $2, 'failed', 'human', $3,
                 'מחיקה בהוראת הבעלים מחקה את הפנייה שהמשימה המתינה למענה עליה, והמשימה לא תוכל להמשיך')`,
        [jobId, phase, envelopeId],
      );
    }

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
  const filesAlreadyGone: string[] = [];
  const filesFailed: string[] = [];
  for (const path of plan.filePaths) {
    try {
      await unlink(path);
      filesRemoved += 1;
    } catch (err) {
      // A file that was already gone is not a failure: the goal was that it
      // not be there, and it is not. It is not a deletion either, and it is
      // recorded as its own third outcome rather than folded into silence.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        filesAlreadyGone.push(path);
        continue;
      }
      filesFailed.push(path);
    }
  }

  const outcome: ErasureOutcome = { deleted: results, filesRemoved, filesAlreadyGone, filesFailed };

  // Real counts, not the preview's: the whole point of this row is to
  // survive as the one record of what happened, and what happened is what
  // the statements above actually reported.
  //
  // **One row per erasure, deliberately — and a documented deviation from the
  // spec** (final review, N9). Spec §7 says a file-deletion failure is
  // recorded as a SEPARATE audit row; it is folded into this one's `reason`
  // instead (`N קבצים לא נמחקו מהדיסק`), with the paths shown on screen. One
  // row per erasure is the better shape — a reader counting erasures should
  // not have to know which of two rows is the erasure and which is a footnote
  // on it — but the deviation was never written down anywhere, and a spec
  // claiming a row the code does not write is the same defect as a control
  // that overstates itself.
  // `total` counts CONTENT DESTROYED — `delete` and `scrub` rows. `fail`
  // excluded on purpose (fix round 3, item 4): failing a stranded job
  // destroys nothing, it stops one, and folding it into the same sum would
  // double-count the one physical row it shares with `jobs:scrub` (a
  // stranded job's pointer is non-null, so it always matches
  // `JOBS_SCRUBBED_PREDICATE` too) — the first place in this module where two
  // items are NOT disjoint by construction the way `approval_requests`'s
  // `delete`/`scrub` pair is. The item still appears in `plan.items` and
  // `outcome.deleted` in full — the owner should see the job will be
  // stopped — it just is not content the erasure destroyed.
  const total = results
    .filter((item) => item.action !== 'fail')
    .reduce((sum, item) => sum + item.count, 0);

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
          (filesAlreadyGone.length > 0
            ? ` · ${filesAlreadyGone.length} קבצים כבר לא היו על הדיסק`
            : '') +
          (filesFailed.length > 0 ? ` · ${filesFailed.length} קבצים לא נמחקו מהדיסק` : ''),
      },
      { businessId },
    );
  } catch (err) {
    throw new ErasureAuditUnrecordedError(outcome, err);
  }

  return outcome;
}
