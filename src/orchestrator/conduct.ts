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
import { renderArtifactFull } from '../documents/brief.js';
import { readDocument, type ReadDocumentOptions } from '../documents/read.js';
import {
  documentsAwaitingRead,
  loadArtifacts,
  readingsToday,
  recordReadFailure,
} from '../documents/store.js';
import type { Plan } from '../domain/plan.js';
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
 * **A one-step judging plan is bound to the delegating job — Task 4 of the
 * verification-loop plan, replacing what this docblock used to describe.**
 * A round-0/1 version of this function bound no plan at all, on the theory
 * that binding one would race `runDueJobs` picking the job up and running it
 * for real while the delegation call below was still in flight. That theory
 * was sound about the DANGER (see the race note below) but wrong about the
 * fix: the actual repair this task makes is to bind the plan FIRST, while
 * the job is still in `execute`, and never fail the job afterward — not to
 * leave it planless. The bound plan's one step names `assert.evaluate`
 * (`orchestrator/local-tools.ts`), never `agent.request_help`: that tool
 * classifies to `agent.delegate`, and this job's `unknown_external`
 * provenance floors gate stage 8's `provenanceCeiling` at `draft_only` —
 * a step naming it would be refused before it could ever delegate.
 * `assert.evaluate` is read-only and short-circuits at gate stage 4, so no
 * ceiling ever applies to it. It carries `ctx.subjectJobId`, `ctx.documentId`,
 * the same `draftTextFor(action)` this function hands the delegation call
 * below, and `VERIFICATION_QUESTION` — the four fields its own handler
 * parses — so that once an answer exists, the step can find and judge it
 * without anything threading a first step's output into a second step's
 * input (there is no first step; the delegation below is a direct call, not
 * a plan step).
 *
 * **`answer: null` on every call this function makes, and the delegating job
 * is left running rather than ended here — the actual fix, corrected from
 * what used to be fix round 1's Critical 2.** `verifyDraft`'s own
 * `requestHelp` call parks the delegating job in `followup`, awaiting an
 * envelope `know.reader`'s child will answer. A round-0/1 version of this
 * function believed nothing would ever resume that park and transitioned the
 * delegating job straight to `failed` itself, immediately, to pre-empt an
 * operator-visible `run_due: no_plan_bound` it believed was otherwise
 * inevitable — undoing the very park `requestHelp` had just performed, on
 * EVERY card the conductor ever raised. That belief was the bug: with a plan
 * now bound before the delegation opens, `resumeDelegatedJobs` (run on every
 * `schedulerPass`) wakes the parked job back to `execute` once `know.reader`
 * answers, and `runDueJobs` finds a job that actually has something to run —
 * the bound `assert.evaluate` step, which judges the draft and saves the
 * verdict. Nothing in this function moves the job's phase after the
 * delegation call succeeds; `requestHelp` (inside it) already did, and
 * `resumeDelegatedJobs` owns it from there.
 *
 * **Every failure here is still caught and turned into a terminal transition
 * of whatever job this call created — fix round 1's Important 3, unchanged.**
 * The same repair the sibling `catch` lower in this file makes for the
 * document's own job: a throw that leaves a job in
 * `intake`/`understand`/`plan`, or in `execute` with a plan nothing will ever
 * run because the throw happened before the delegation could park it, is a
 * job in a phase either with no reader at all or with a reader that fails it
 * loudly — CLAUDE.md's "a phase with no reader is not a resting place, it's
 * a leak". `{ opened: false }` is this function's own count of that failure,
 * surfaced by the caller as `ConductResult.verificationFailed` and
 * distinguishable from "verification simply was never attempted".
 * `run-scheduler.ts`'s `logErrored` prints a line whenever it is nonzero.
 *
 * **A known, unclosed race across TWO SCHEDULER PROCESSES, now a different
 * shape than it used to be.** Within one process the ordering is safe:
 * `schedulerPass` runs the conductor to completion before it calls
 * `runDueJobs` (`scheduler.ts`'s own docblock), so the delegating job this
 * function creates is never still sitting in `execute` when that same
 * process's `runDueJobs` looks. Across two separate scheduler PROCESSES this
 * does not hold: `conductPendingDocuments`'s advisory lock (`conductor:
 * ${businessId}`) and `runDueJobs`'s (`run-due:${businessId}:${jobId}`) are
 * different scopes. The window this function used to leave open — a job in
 * `execute` with NO bound plan — is closed by binding the plan first. A
 * narrower window remains: between this function's own `bindPlanToJob` call
 * and the delegation call parking the job to `followup`, a second process's
 * `runDueJobs` can find the delegating job in `execute` WITH its plan
 * already bound, and run the `assert.evaluate` step for real before any
 * delegation has been requested — that step finds no help-request envelope
 * yet (`loadHelpRequestFromParentJob` returns `null`) and refuses
 * non-retryably with `verification_answer_missing`, failing the job. Not
 * reachable with a single `npm run scheduler` process, which is every
 * deployment this codebase runs today (`docs/dashboard-deployment.md`); it
 * becomes reachable the day a second scheduler process is ever started
 * against the same business — the same caveat the old race note carried,
 * on a narrower window than before.
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
      reason: 'conductor: binding the one-step judging plan',
      businessId: ctx.businessId,
    });
    await transition(delegatingJob.jobId, {
      to: 'execute',
      actor: 'orchestrator',
      reason: 'conductor: ready for gov.verify to run its checks',
      businessId: ctx.businessId,
    });

    // Bound BEFORE the delegation opens, while the job is still in
    // `execute` — see this function's own docblock. The single step names
    // `assert.evaluate`, never `agent.request_help`: that tool classifies to
    // `agent.delegate`, and gate stage 8's `provenanceCeiling` for this job's
    // `unknown_external` provenance floors at `draft_only`, refusing it
    // before it could ever delegate. `assert.evaluate` is read-only and
    // short-circuits at gate stage 4, so no ceiling ever reaches it. Its
    // payload is exactly the four fields its own handler
    // (`orchestrator/local-tools.ts`) parses.
    const plan: Plan = {
      goal: `אימות הטיוטה של משימה ${ctx.subjectJobId}`,
      assumptions: [],
      clarifyingQuestion: null,
      estimatedCostMinor: 0,
      steps: [
        {
          id: 'judge',
          agent: 'gov.verify',
          intent: 'לשפוט את הטיוטה מול מה שהמסמך מבקש',
          toolName: 'assert.evaluate',
          input: {
            subjectJobId: ctx.subjectJobId,
            documentId: ctx.documentId,
            draftText: draftTextFor(action),
            question: VERIFICATION_QUESTION,
          },
          dependsOn: [],
          expectedActionClass: null,
        },
      ],
    };
    await bindPlanToJob(delegatingJob.jobId, plan, { businessId: ctx.businessId });

    // The document's own deterministic extraction, laid out as PLAIN TEXT —
    // never the truncated prompt brief (`renderReadingBrief`), which DROPS
    // WHOLE SECTIONS past its character cap (fix round 1's Important 5), and
    // never `JSON.stringify(artifact.content)` either (fix round 2's item 1:
    // that was tried and was WORSE than the brief). `numbersIn`
    // (`numeric-grounding.ts`) skips any digit run immediately preceded by
    // `:` — a date/time/range guard — and `JSON.stringify` emits no space
    // after a key's colon, so a numeric cell (`{"v":11988,"t":"number"}`) has
    // its own value skipped by that exact guard. On a spreadsheet or table
    // artefact this zeroes the ENTIRE grounded set, and because `sources` is
    // non-empty the "an empty source list grounds everything" safety never
    // fires — every number in the draft then reads as ungrounded, the exact
    // false-positive shape `numeric-grounding.ts`'s own docblock warns
    // teaches an owner to click past the control. `renderArtifactFull`
    // (`documents/brief.ts`) is the fix: the same cell/block layout
    // `renderReadingBrief` renders, with neither of its two caps applied. See
    // that function's own docblock for what it still does NOT capture
    // (extraction-time caps recorded in `artifact.flags`, which it does not
    // read).
    const artifacts = await loadArtifacts(ctx.documentId, { businessId: ctx.businessId });
    const sources = artifacts.map((artifact) => renderArtifactFull(artifact));

    // The delegation itself, unchanged — this task changes what happens
    // around this call, never the call: same args, same `answer: null`, same
    // refusal-throwing inside `verifyDraft`. What no longer follows it is a
    // kill: `requestHelp` (inside `ctx.verifier`, on the branch production
    // always takes) has already parked the job in `followup`, with a plan
    // now bound for `resumeDelegatedJobs`/`runDueJobs` to find and run once
    // `know.reader` answers. Nothing here moves the phase again — see this
    // function's own docblock for the bug this replaces.
    await ctx.verifier({
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
   * exists and stays exactly as raised (fix round 1's Important 3). Printed
   * by `run-scheduler.ts`'s `logErrored` whenever nonzero (fix round 2's
   * item 2) — a count this struct carries but nothing ever printed is not
   * yet distinguishable from "no verification was ever attempted".
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
