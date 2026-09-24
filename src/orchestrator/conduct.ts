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
import { renderReadingBrief } from '../documents/brief.js';
import { readDocument, type ReadDocumentOptions } from '../documents/read.js';
import {
  documentsAwaitingRead,
  loadArtifacts,
  readingsToday,
  recordReadFailure,
} from '../documents/store.js';
import type { ProposedAction } from '../domain/proposal.js';
import { verifyDraft, type VerifyDraftInput, type VerifyDraftResult } from '../sdk/gov-verify.js';
import { createJob, transition, type Job } from './jobs.js';
import { bindPlanToJob } from './plan-store.js';
import { proposalToPlan } from './proposal-to-plan.js';
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
  /**
   * Injected by tests so `verifyDraft`'s own delegation (`requestHelp` —
   * deterministic and free of any model call on the branch this module ever
   * takes, since it never supplies `answer`) can be replaced with a stub that
   * observes or throws, without needing a slow or billed call to prove the
   * card never waits on it and is never undone by it. Production leaves this
   * unset and gets the real `verifyDraft`.
   */
  verifier?: (input: VerifyDraftInput) => Promise<VerifyDraftResult>;
}

/**
 * Fixed and code-owned, never derived from the document or the proposal.
 * `gov.verify` composes its own question to `know.reader` — letting a
 * hostile document (or even the proposal a model wrote from reading one)
 * choose the question would be asking the thing under suspicion to pick the
 * question the quarantine boundary is graded against.
 */
const VERIFICATION_QUESTION =
  'מה מבקש המסמך הזה בפועל, ומה צריך להיכלל בתגובה כדי לענות על כך במלואו?';

/**
 * The text `gov.verify` judges — the proposed action's own `body` when it has
 * one (the common case: an email, a message), or the whole payload
 * stringified when it does not. `ProposedAction.input` carries no fixed
 * schema across tools (`domain/proposal.ts`), so there is no single field
 * name this module can trust to exist.
 */
function draftTextFor(action: ProposedAction): string {
  const body = action.input['body'];
  return typeof body === 'string' && body.length > 0 ? body : JSON.stringify(action.input);
}

/**
 * Open a `gov.verify` job for the action a card is about to be (or was just)
 * raised for — BESIDE the card, never before it. Called only after the
 * card's own job has already reached `await_approval`, and wrapped in its own
 * `try`/`catch` at the call site: a verification that cannot even get
 * started must never undo, or fail, a card the owner is already able to see.
 *
 * **No plan is bound to this job.** `verifyDraft` is called directly here,
 * the same way `curateJob` calls `writeMemory` directly — never through
 * `runLocalTool`/the generic plan-step executor (see `verifyDraft`'s own
 * docblock, and `erasure-plan.ts`'s `VERIFICATION_VERDICTS_ERASED_PREDICATE`
 * docblock, which names this exact decision). Binding a plan anyway would
 * leave a job sitting in `execute` with something `runDueJobs` might pick up
 * and try to run for real — racing this very call, the same danger
 * `requestHelp`'s own docblock names for its child job and closes by never
 * leaving that window open. The same fix applies here: create, walk straight
 * to `execute`, and call `verifyDraft` in the same breath, under this pass's
 * own advisory lock.
 *
 * **`answer: null` on every call this function makes.** This task opens the
 * delegation and stops there — `verifyDraft` ends its own run and returns
 * `awaiting_delegation`; nothing yet resumes this job with a second call once
 * `know.reader`'s child job answers. `resumeDelegatedJobs` will free this job
 * back to `execute` when its child finishes, but this job carries no bound
 * plan for `runDueJobs` to run once it gets there, so it will sit in
 * `execute` un-rerun. A known, named gap — not an oversight — see the task
 * report for Task 11.
 *
 * **A `requestHelp` refusal surfaces from `verifyDraft` as a thrown error**
 * (its own docblock), and this function does not distinguish it from any
 * other failure here (a charter that failed to load, a database blip while
 * reading artefacts). All of it is caught, uniformly, at the call site: the
 * verification is advisory to what the card already shows, never a gate on
 * it, and its absence renders as no verdict at all — a state the card already
 * has to handle, since a verdict may equally never arrive because nothing
 * resumed the delegation yet.
 */
async function beginVerification(
  action: ProposedAction,
  ctx: {
    documentId: string;
    businessId: string;
    charterVersion: string;
    verifier: (input: VerifyDraftInput) => Promise<VerifyDraftResult>;
  },
): Promise<void> {
  const verifyJob = await createJob({
    charterVersion: ctx.charterVersion,
    // Not a parameter, and not derived from anything the document or the
    // proposal says — see `the verification job carries unknown_external as
    // a literal` in conduct.test.ts.
    provenance: 'unknown_external',
    businessId: ctx.businessId,
    title: `אימות: ${action.headline}`,
  });

  await transition(verifyJob.jobId, {
    to: 'understand',
    actor: 'orchestrator',
    reason: 'conductor: opening gov.verify beside the card',
    businessId: ctx.businessId,
  });
  await transition(verifyJob.jobId, {
    to: 'plan',
    actor: 'orchestrator',
    reason: 'conductor: no plan is bound — verifyDraft runs directly',
    businessId: ctx.businessId,
  });
  await transition(verifyJob.jobId, {
    to: 'execute',
    actor: 'orchestrator',
    reason: 'conductor: ready for gov.verify to run its checks',
    businessId: ctx.businessId,
  });

  const artifacts = await loadArtifacts(ctx.documentId, { businessId: ctx.businessId });
  const { brief } = renderReadingBrief(artifacts);

  await ctx.verifier({
    parentJobId: verifyJob.jobId,
    documentId: ctx.documentId,
    draftText: draftTextFor(action),
    sources: [brief],
    question: VERIFICATION_QUESTION,
    answer: null,
    parentEnvelope: null,
    businessId: ctx.businessId,
  });
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

        // Compiled and bound BEFORE the card goes up, and that order is the
        // fix rather than an incidental detail.
        //
        // Until 11/09 nothing was bound at all. The card was raised, the job
        // moved to `await_approval`, the owner approved, `resumeAfterDecision`
        // moved it to `execute` — and `runDueJobs` found a job with no plan
        // and moved it to `failed` with `no_plan_bound`. Approving a
        // conductor card did nothing whatsoever, and would have gone on doing
        // nothing however high the ramp rose. `proposalToPlan` had been built
        // and tested since the proposal planner shipped and had no production
        // caller; this is it.
        //
        // A crash between the two writes must not be able to produce a card
        // the owner can approve into that same failure. In this order the
        // worst case is a `plan`-phase job carrying a plan nothing will run,
        // which is inert: `runDueJobs` takes only jobs in `execute`. In the
        // other order the worst case is the bug being fixed here.
        //
        // The step carries `action.input` verbatim (`proposalToPlan`), which
        // is what makes the approval findable when the plan finally runs:
        // `enqueueApproval` hashes the same payload, `unspentApprovalFor`
        // looks the row up by that hash, and `consumeApproval` binds the tool
        // name too. A compilation that reshaped either would leave the owner
        // asked a second time for something they had already approved.
        const compiled =
          proposed.proposal.action === null
            ? null
            : proposalToPlan(proposed.proposal, {
                goal: proposed.proposal.action.headline,
              });
        if (compiled !== null) {
          stage = 'binding the compiled plan';
          await bindPlanToJob(job.jobId, compiled, { businessId });
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

        // Beside the card, never before it — see `beginVerification`'s own
        // docblock. Swallowed here, deliberately, and not by letting it reach
        // the `catch` below: that `catch` fails the DOCUMENT's own job, and a
        // verification that stumbles must never undo a card the owner can
        // already see.
        if (proposed.proposal.action !== null) {
          try {
            await beginVerification(proposed.proposal.action, {
              documentId: document.documentId,
              businessId,
              charterVersion: active.charter.charterVersion,
              verifier: options.verifier ?? verifyDraft,
            });
          } catch {
            // Best-effort. The card already exists and the job already moved
            // to `await_approval`; a verification that could not even start
            // is a known gap (see `beginVerification`'s docblock), not a
            // reason to take either of those back.
          }
        }
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
