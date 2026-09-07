/**
 * Loop B — understanding. This is the half that costs money.
 *
 * One job per document, walked through the phases for real
 * (`intake → understand → plan → await_approval`) so the audit trail describes
 * a history that happened. A job left in `intake` with a reading and a proposal
 * hanging off it would describe one that did not.
 *
 * Failure is per document, never per batch: one document that cannot be read
 * must not stop the ones behind it, which is the rule `ingestDocument` already
 * keeps for a hostile file. And a job that hit that failure must not be left
 * stranded either — see the `catch` block below, which recovers both.
 */
import { config } from '../config.js';
import { loadActiveCharter } from '../charter/store.js';
import { getPool } from '../db/pool.js';
import { readDocument, type ReadDocumentOptions } from '../documents/read.js';
import {
  documentsAwaitingRead,
  readingsToday,
  recordReadFailure,
} from '../documents/store.js';
import { createJob, transition, type Job } from './jobs.js';
import { proposeForReading, type ProposeForReadingOptions } from './propose.js';
import { raiseProposalApproval, type NotifyTarget } from './proposal-approval.js';

export interface ConductOptions {
  businessId?: string;
  /** Defaults to `config.documentReadsPerDay`. */
  readsPerDay?: number;
  /** Most documents to consider in one pass, regardless of the daily ceiling. */
  limit?: number;
  reader?: ReadDocumentOptions['reader'];
  proposer?: ProposeForReadingOptions['proposer'];
  /**
   * Where to tell the owner a card is waiting. Threaded from `buildRuntime`
   * through `schedulerPass`, and absent exactly when that function could not
   * assemble a notifier — six SMTP variables plus `APPROVAL_NOTIFY_TO`.
   *
   * Absent is a real production state, not a test-only one, and it is not a
   * failure: the card is written and the dashboard shows it either way. What
   * it must never be is silent, which is why `buildRuntime` returns a warning
   * for it rather than simply omitting the field (I3).
   */
  notify?: NotifyTarget;
}

export interface ConductResult {
  considered: number;
  /** Proposals that carried an action and produced a pending card. */
  carded: number;
  /** Proposals with no action — stored, and visible only on the readings screen. */
  readOnly: number;
  failed: number;
  ceilingReached: boolean;
}

/**
 * Record a document failure without letting a failure to record it escalate
 * into a failure of the whole pass.
 *
 * `recordReadFailure` is itself a plain `UPDATE`, and if it throws — the
 * database blipped, a constraint nobody expected — the exception would
 * otherwise propagate out of the per-document `catch` that calls it, which
 * rejects `conductPendingDocuments` entirely and discards every count this
 * pass had already accumulated for the documents processed before this one
 * (M5).
 */
async function recordReadFailureSafely(
  documentId: string,
  message: string,
  businessId: string,
): Promise<void> {
  try {
    await recordReadFailure(documentId, message, { businessId });
  } catch {
    // Swallowed on purpose — see the docblock above. The caller already
    // counts this document as failed; losing the written reason is a smaller
    // loss than losing the whole pass's results.
  }
}

export async function conductPendingDocuments(
  options: ConductOptions = {},
): Promise<ConductResult> {
  const businessId = options.businessId ?? config.businessId;
  const readsPerDay = options.readsPerDay ?? config.documentReadsPerDay;
  const limit = options.limit ?? 10;

  const result: ConductResult = {
    considered: 0,
    carded: 0,
    readOnly: 0,
    failed: 0,
    ceilingReached: false,
  };

  // Session-scoped `pg_try_advisory_lock`, not `pg_try_advisory_xact_lock`.
  // This pass makes real external calls (the reader, the proposer) bounded
  // only by their own deadlines, and holding a database transaction open
  // across that wire for the whole pass is the mistake `runDueJobs`
  // (`run-due.ts`) already documents avoiding, for the same reason: a ten-
  // connection pool does not survive two concurrent passes each parking a
  // transaction behind an external call. The lock is taken on a client
  // checked out for exactly this purpose and released in a `finally`.
  //
  // **Where the parity with `run-due.ts` stops, stated because an earlier
  // version of this comment claimed more than the code does (M9).** What is
  // genuinely shared is the `finally` block's shape: the unlock attempt and
  // the release kept apart so `release` is called exactly once, and a failed
  // unlock destroying the connection rather than returning a session that
  // still holds the lock. The checkout scope is *not* shared. `run-due`
  // checks out and releases one connection per job, so a slow job holds one
  // pool slot for its own duration; this function holds a single connection
  // for the whole pass — every document, every model call inside it. On a
  // ten-connection pool that is one slot parked for as long as the batch
  // takes, which is a real difference and not a detail.
  //
  // `pg_try_advisory_lock`, not the blocking form: a second pass that cannot
  // get the lock must skip this round and come back later, never queue
  // behind the first and then repeat its work once the first finishes.
  // Without this, two overlapping passes read the same `remaining` budget
  // and the same waiting documents, and can turn one document into two jobs,
  // two proposals and two cards for the owner to answer (I3).
  const lockScope = `conductor:${businessId}`;
  const client = await getPool().connect();
  let holdsLock = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [lockScope],
    );
    if (lock.rows[0]?.locked !== true) {
      // Another pass already holds this business's lock. Zero result, same
      // as "nothing to do" — the caller cannot tell the difference, and does
      // not need to: the next pass will pick this back up.
      return result;
    }
    holdsLock = true;

    // No charter, no reasoning: the bundle is what the proposer's catalogue
    // and the risk engine's ceilings are both derived from. `evaluateToolCall`
    // treats an absent charter as fatal for the same reason.
    const active = await loadActiveCharter(businessId);
    if (active === null) return result;

    const alreadyToday = await readingsToday({ businessId });
    let remaining = readsPerDay - alreadyToday;
    if (remaining <= 0) {
      result.ceilingReached = true;
      return result;
    }

    const waiting = await documentsAwaitingRead(limit, { businessId });

    for (const document of waiting) {
      if (remaining <= 0) {
        result.ceilingReached = true;
        break;
      }
      result.considered += 1;
      // The ceiling counts documents considered in this pass, not model
      // calls actually made — a document served from the reading cache, or
      // one that fails before `readDocument` ever runs, still spends a slot
      // here (M1). That can only under-run the daily budget, never exceed
      // it, and `remaining` is recomputed fresh on the next pass regardless.
      //
      // What it does **not** bound, said plainly: `readsPerDay` is measured
      // against `readingsToday`, which counts `document_readings` rows, and
      // every document that gets this far also makes a paid *proposer* call
      // that writes no such row. On the re-offer path — reading already
      // cached, no proposal yet — the proposer runs while `readingsToday`
      // does not move at all. So spec §8's "how many documents may be
      // understood in a day" bounds one of the two model calls that
      // understanding costs. The exposure is small and bounded from the other
      // side (`documentsAwaitingRead` filters on `read_attempts < 3`, and
      // `limit` caps a pass), but it is not what the name promises.
      remaining -= 1;

      // Hoisted above the `try` so the `catch` below can tell whether a job
      // was ever created for this document, and if so, close it out instead
      // of leaving it stranded — see the `catch` block (I1).
      let job: Job | null = null;
      let stage = 'creating the job';

      try {
        job = await createJob({
          charterVersion: active.charter.charterVersion,
          // Not a parameter, and not derived from anything a document says.
          provenance: 'unknown_external',
          businessId,
          title: `מסמך: ${document.originalName}`,
        });

        stage = 'transitioning to understand';
        await transition(job.jobId, {
          to: 'understand',
          actor: 'orchestrator',
          reason: 'conductor: reading an ingested document',
          businessId,
        });

        stage = 'reading the document';
        const read = await readDocument(
          {
            documentId: document.documentId,
            jobId: job.jobId,
            provenance: 'unknown_external',
            bundle: active.bundle,
          },
          {
            businessId,
            ...(options.reader !== undefined ? { reader: options.reader } : {}),
          },
        );

        if (read.status !== 'read') {
          await recordReadFailureSafely(document.documentId, `read: ${read.status}`, businessId);
          await transition(job.jobId, {
            to: 'failed',
            actor: 'orchestrator',
            reason: `conductor: ${read.status}`,
            businessId,
          });
          result.failed += 1;
          continue;
        }

        stage = 'transitioning to plan';
        await transition(job.jobId, {
          to: 'plan',
          actor: 'orchestrator',
          reason: 'conductor: proposing from the reading',
          businessId,
        });

        stage = 'proposing from the reading';
        const proposed = await proposeForReading(
          { documentId: document.documentId, jobId: job.jobId, bundle: active.bundle },
          {
            businessId,
            ...(options.proposer !== undefined ? { proposer: options.proposer } : {}),
          },
        );

        if (proposed.status !== 'proposed') {
          await recordReadFailureSafely(
            document.documentId,
            `propose: ${proposed.status}`,
            businessId,
          );
          await transition(job.jobId, {
            to: 'failed',
            actor: 'orchestrator',
            reason: `conductor: ${proposed.status}`,
            businessId,
          });
          result.failed += 1;
          continue;
        }

        stage = 'raising the approval';
        const approvalId = await raiseProposalApproval(
          { jobId: job.jobId, proposal: proposed.proposal, bundle: active.bundle },
          { businessId, ...(options.notify !== undefined ? { notify: options.notify } : {}) },
        );

        if (approvalId === null) {
          // A stance with nothing to approve. The proposal is stored and the
          // owner sees it on the readings screen; the job has nowhere further
          // to go, so it closes rather than sitting in `plan` forever.
          stage = 'closing a proposal with no action';
          await transition(job.jobId, {
            to: 'closed',
            actor: 'orchestrator',
            reason: 'conductor: proposal carries no action',
            businessId,
          });
          result.readOnly += 1;
          continue;
        }

        stage = 'transitioning to await_approval';
        await transition(job.jobId, {
          to: 'await_approval',
          actor: 'orchestrator',
          reason: `conductor: ${approvalId}`,
          businessId,
        });
        result.carded += 1;
      } catch (err) {
        // Per document, never per batch.
        const message = err instanceof Error ? err.message : String(err);
        await recordReadFailureSafely(document.documentId, message, businessId);
        result.failed += 1;

        // The document's failure is recorded above regardless. But a job may
        // already exist for it — `createJob` succeeded before the throw, or
        // one of the phases past it did — and every phase a throw can leave
        // it in (`intake`, `understand`, `plan`) has no reader anywhere in
        // production: `run-due.ts` selects `execute`, `wakeDueJobs` selects
        // `followup`, `closeVerifiedJobs` selects `verify`/`remember`. Left
        // alone, that row sits forever — "a phase with no reader is not a
        // resting place, it's a leak" (CLAUDE.md). Closing it out here is
        // itself wrapped: a failing transition (the job already moved, or the
        // database is having the same bad moment that caused the original
        // throw) must not escape and re-break the batch a second time.
        if (job !== null) {
          try {
            await transition(job.jobId, {
              to: 'failed',
              actor: 'orchestrator',
              reason: `conductor: threw while ${stage}: ${message}`,
              businessId,
            });
          } catch {
            // Best-effort. The document is already marked failed above; a
            // job that cannot be closed out here is a known gap, not a new
            // one this pass is responsible for solving.
          }
        }
      }
    }

    return result;
  } finally {
    if (holdsLock) {
      // The unlock attempt and the release are kept apart so `release` is
      // called exactly once on every path, mirroring `run-due.ts`'s own
      // reasoning: nesting `client.release()` in the `try` and
      // `client.release(err)` in a `catch` would release twice if `release`
      // itself ever threw.
      let unlockError: unknown;
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockScope]);
      } catch (error) {
        unlockError = error;
      }
      if (unlockError === undefined) {
        client.release();
      } else {
        // A session-scoped advisory lock lives on the session, not the pool
        // slot. A plain release after a failed unlock would return a session
        // that still holds this business's lock to the pool, silently
        // locking every future pass out of it. Passing the error tells `pg`
        // to destroy the connection instead of pooling it.
        client.release(
          unlockError instanceof Error ? unlockError : new Error(String(unlockError)),
        );
      }
    } else {
      client.release();
    }
  }
}
