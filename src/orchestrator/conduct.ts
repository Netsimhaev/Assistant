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
 * Open a `gov.verify` job for the action a card was just raised for — BESIDE
 * the card, never before it. Called only after the card's own job (`job`,
 * at the call site) has already reached `await_approval`.
 *
 * **The delegating job and the subject job are two different rows, on
 * purpose — fix round 1's Critical 1.** `verifyDraft`'s `parentJobId` is the
 * job DOING the delegating, and `requestHelp` requires it to be in
 * `execute`; this function opens a fresh one for exactly that
 * (`delegatingJob` below). `ctx.subjectJobId` is the DOCUMENT's own job —
 * already sitting in `await_approval` by the time this runs — which is
 * `saveVerdict`'s key and therefore the id `loadVerdict(approval.jobId)`
 * looks up on the card. The first version of this function passed one job
 * for both roles: it compiled, and it silently wrote every verdict where no
 * card would ever find it, because the document's job can never legally be
 * the delegating job (it is never in `execute` at this point) and
 * `saveVerdict` was keyed on `parentJobId`.
 *
 * **No plan is bound to the delegating job.** `verifyDraft` is called
 * directly here, the same way `curateJob` calls `writeMemory` directly —
 * never through `runLocalTool`/the generic plan-step executor (see
 * `verifyDraft`'s own docblock, and `erasure-plan.ts`'s
 * `VERIFICATION_VERDICTS_ERASED_PREDICATE` docblock, which names this exact
 * decision). Binding a plan anyway would leave a job sitting in `execute`
 * with something `runDueJobs` might pick up and try to run for real —
 * racing this very call, the same danger `requestHelp`'s own docblock names
 * for its child job and closes by never leaving that window open.
 *
 * **`answer: null` on every call this function makes, and the delegating
 * job is ended here rather than left parked — fix round 1's Critical 2.**
 * `verifyDraft`'s own `requestHelp` call parks the delegating job in
 * `followup`, awaiting an envelope `know.reader`'s child will answer, and
 * this task builds no second half that ever resolves it. **A round-0
 * version of this docblock claimed the parked job would simply "sit in
 * `execute` un-rerun" — that was false.** Left alone,
 * `resumeDelegatedJobs` wakes a parked job with a terminal child straight
 * back to `execute`; with no plan ever bound, `run-due.ts` (lines ~194-223)
 * then transitions it to `failed` with `run_due: no_plan_bound`, and
 * `run-scheduler.ts` prints an operator-visible error line for it —
 * `run-due.ts`'s own docblock already names the conductor as the first
 * production producer of exactly this shape of bug. So every carded
 * document would eventually leave one such line on a healthy installation.
 * This function does not wait for that: the moment the delegation opens, it
 * transitions the delegating job straight to `failed` itself, with a reason
 * that names the real cause — a known, named gap (see the Task 11 report),
 * not a silent, deferred, operator-visible one.
 *
 * **Every failure here is caught and turned into a terminal transition of
 * whatever job this call created — fix round 1's Important 3.** The same
 * repair the sibling `catch` lower in this file makes for the document's own
 * job: a throw that leaves a job in `intake`/`understand`/`plan`, or in
 * `execute` with no plan bound, is a job in a phase either with no reader at
 * all or with a reader that fails it loudly — CLAUDE.md's "a phase with no
 * reader is not a resting place, it's a leak". `{ opened: false }` is this
 * function's own count of that failure, surfaced by the caller as
 * `ConductResult.verificationFailed` — visible, unlike a bare swallow, and
 * distinguishable from "verification simply was never attempted".
 */
async function beginVerification(
  action: ProposedAction,
  ctx: {
    subjectJobId: string;
    documentId: string;
    businessId: string;
    charterVersion: string;
    verifier: (input: VerifyDraftInput) => Promise<VerifyDraftResult>;
  },
): Promise<{ opened: boolean }> {
  let delegatingJobId: string | null = null;
  try {
    const delegatingJob = await createJob({
      charterVersion: ctx.charterVersion,
      // Not a parameter, and not derived from anything the document or the
      // proposal says — see `the verification job carries unknown_external as
      // a literal` in conduct.test.ts.
      provenance: 'unknown_external',
      businessId: ctx.businessId,
      title: `אימות: ${action.headline}`,
    });
    delegatingJobId = delegatingJob.jobId;

    await transition(delegatingJob.jobId, {
      to: 'understand',
      actor: 'orchestrator',
      reason: 'conductor: opening gov.verify beside the card',
      businessId: ctx.businessId,
    });
    await transition(delegatingJob.jobId, {
      to: 'plan',
      actor: 'orchestrator',
      reason: 'conductor: no plan is bound — verifyDraft runs directly',
      businessId: ctx.businessId,
    });
    await transition(delegatingJob.jobId, {
      to: 'execute',
      actor: 'orchestrator',
      reason: 'conductor: ready for gov.verify to run its checks',
      businessId: ctx.businessId,
    });

    // The document's own deterministic extraction, in full — never the
    // truncated prompt brief (`renderReadingBrief`), which DROPS WHOLE
    // SECTIONS past its character cap (fix round 1's Important 5). A number
    // surviving only in a section the brief cut away would read as
    // ungrounded on the owner's card with nothing recording that the
    // comparison was incomplete — the exact false-positive shape
    // `numeric-grounding.ts`'s own docblock warns teaches an owner to click
    // past the control. `JSON.stringify` per artifact keeps every digit the
    // extraction actually holds, at the cost of readability nothing here
    // needs — `ungroundedNumbers` only scans for digit runs.
    const artifacts = await loadArtifacts(ctx.documentId, { businessId: ctx.businessId });
    const sources = artifacts.map((artifact) => JSON.stringify(artifact.content));

    const result = await ctx.verifier({
      parentJobId: delegatingJob.jobId,
      subjectJobId: ctx.subjectJobId,
      documentId: ctx.documentId,
      draftText: draftTextFor(action),
      sources,
      question: VERIFICATION_QUESTION,
      answer: null,
      parentEnvelope: null,
      businessId: ctx.businessId,
    });

    // See this function's own docblock (Critical 2): ending the delegating
    // job here, ourselves, is the fix for the operator-visible
    // `no_plan_bound` failure that leaving it parked would eventually cause.
    if ('status' in result && result.status === 'awaiting_delegation') {
      await transition(delegatingJob.jobId, {
        to: 'failed',
        actor: 'orchestrator',
        reason:
          'gov.verify: delegated to know.reader, but nothing yet resumes this job to complete ' +
          'the check (known gap, Task 11) — ended here rather than parked for run_due to fail ' +
          'later as no_plan_bound',
        businessId: ctx.businessId,
      });
    }

    return { opened: true };
  } catch (err) {
    if (delegatingJobId !== null) {
      try {
        await transition(delegatingJobId, {
          to: 'failed',
          actor: 'orchestrator',
          reason: `conductor: verification threw: ${err instanceof Error ? err.message : String(err)}`,
          businessId: ctx.businessId,
        });
      } catch {
        // Best-effort, the same posture the document job's own sibling catch
        // (below) takes: a job that cannot be closed out here is a known
        // gap, not a new one this function is responsible for solving.
      }
    }
    return { opened: false };
  }
}

export interface ConductResult {
  considered: number;
  /** Proposals that carried an action and produced a pending card. */
  carded: number;
  /** Proposals with no action — stored, and visible only on the readings screen. */
  readOnly: number;
  failed: number;
  ceilingReached: boolean;
  /**
   * `beginVerification` returned `{ opened: false }` — a refusal, a charter
   * load failure, or a database blip stopped verification from ever getting
   * under way. This never touches `failed`: the card it sat beside already
   * exists and stays exactly as raised (fix round 1's Important 3) — this
   * count exists only so the failure is visible instead of indistinguishable
   * from "no verification was ever attempted".
   */
  verificationFailed: number;
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
    verificationFailed: 0,
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
        // docblock for why the document's own job (`job`, its subject) and
        // the job doing the delegating must never be the same row.
        // `beginVerification` catches everything internally and never
        // throws; its own return value is what the caller counts, never the
        // exception this loop's outer `catch` would otherwise treat as a
        // failure of the DOCUMENT's own job — a verification that stumbles
        // must never undo a card the owner can already see.
        if (proposed.proposal.action !== null) {
          const verified = await beginVerification(proposed.proposal.action, {
            subjectJobId: job.jobId,
            documentId: document.documentId,
            businessId,
            charterVersion: active.charter.charterVersion,
            verifier: options.verifier ?? verifyDraft,
          });
          if (!verified.opened) result.verificationFailed += 1;
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
