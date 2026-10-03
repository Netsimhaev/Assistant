/**
 * The report: the one sentence the owner reads over WhatsApp once a job his
 * own instruction opened has reached a state worth telling him about.
 *
 * **Keyed on the record, never on the phase alone.** `closeVerifiedJobs`
 * (`verify.ts`) already closes a job whose every declared step has a
 * `completed` row — that is what makes `phase = 'closed'` mean anything at
 * all — but `completed` only ever meant "a result came back", never "the
 * result was that something actually happened". A tool with no handler
 * returns `{ performed: false, reason: 'not_implemented' }`; `performStep`
 * reports that as a successful step outcome; the step is recorded
 * `completed`; the job closes. `phase === 'closed' ? 'performed' : 'failed'`
 * would tell the owner a CRM order was entered when nothing was. The first
 * classifier branch below exists only to refuse that shortcut — see
 * migration 037 and `StepEffect.performed` (`execute.ts`) for where the fact
 * this branch reads is actually written down.
 *
 * **Report-once reuses `whatsapp_messages.state`, never a second ledger.**
 * `'reported'` is migration 036's fifth state, added for exactly this task
 * and written by nothing until now. `claimForReport` (`whatsapp/store.ts`)
 * moves the OPENING message — the one `linkWhatsAppMessage` tied to the job —
 * from `'handled'`/`'failed'` to `'reported'` with one conditional `UPDATE`,
 * the same claim shape `claimMessage` already uses: a read-then-write would
 * let two overlapping passes both see an unreported row and both send.
 *
 * **The claim happens right before the send, not before classification.**
 * Classifying a job is read-only and can be retried for free; claiming
 * cannot — a message moved to `'reported'` is not considered again by the
 * next pass. Claiming first and then failing to classify would burn the one
 * report an instruction ever gets without the owner hearing anything.
 *
 * **`messenger.send` never throws** (`BossMessenger`'s own contract), so
 * nothing here wraps it — a delivery failure is the messenger's own fact to
 * record (`recordAttempt` inside `createBossMessenger` settles the row it
 * wrote to `'failed'`), not this function's to recover from. A job's report
 * is sent once; what became of the send is the messenger's business.
 */
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import { JobPhase } from '../domain/job.js';
import { pendingApprovalForJob } from '../governance/approvals.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { claimForReport } from '../whatsapp/store.js';
import { jobHistory } from './jobs.js';
import { loadPlanBody, stepResults } from './plan-store.js';

export type ReportOutcome = 'performed' | 'not_implemented' | 'failed' | 'awaiting_approval';

export interface ReportResult {
  reported: number;
}

/**
 * Default dashboard origin for the approval link on an `awaiting_approval`
 * report. Not imported from `orchestrator/runtime.ts` (private to that
 * module) or `dashboard/oauth-routes.ts` (a dashboard module an orchestrator
 * module must not reach into — no production code crosses that direction
 * today) — a third independent copy, for the same reason this codebase
 * already carries two: each site's fallback is its own to state, not a
 * shared import whose owner could change it out from under this one.
 */
const DEFAULT_DASHBOARD_BASE_URL = 'http://127.0.0.1:8787';

const NOT_IMPLEMENTED_TEXT =
  'סיימתי לטפל בהוראה, אבל חלק מהפעולות בה לא בוצע: עדיין אין לי אפשרות טכנית לבצע אותן באופן אוטומטי. אפשר לראות בדשבורד בדיוק אילו.';

const PERFORMED_TEXT = 'סיימתי — מה שביקשת בוצע בהצלחה.';

const FAILED_GENERIC_TEXT = 'הניסיון לבצע את ההוראה נכשל, והסיבה לא נשמרה.';

const AWAITING_APPROVAL_GENERIC_TEXT =
  'הפעולה הזו דורשת את האישור שלך לפני שהיא תבוצע. אפשר לאשר אותה מהדשבורד.';

function failedText(reason: string | null): string {
  return reason === null ? FAILED_GENERIC_TEXT : `הניסיון לבצע את ההוראה נכשל: ${reason}`;
}

function awaitingApprovalText(approvalUrl: string | null): string {
  return approvalUrl === null
    ? AWAITING_APPROVAL_GENERIC_TEXT
    : `הפעולה הזו דורשת את האישור שלך לפני שהיא תבוצע. אפשר לאשר כאן: ${approvalUrl}`;
}

interface ReportCandidateRow {
  job_id: string;
  phase: string;
  whatsapp_message_id: string;
}

interface ReportCandidate {
  jobId: string;
  phase: JobPhase;
  messageId: string;
}

/**
 * Jobs that a WhatsApp instruction opened and that have reached a phase
 * worth telling the owner about, whose opening message has not already been
 * reported.
 *
 * `whatsapp_message_id IS NOT NULL` is what excludes every job that did not
 * come from this door — `linkWhatsAppMessage` is the only writer of that
 * column, and it is called only for a job the door actually opened. The
 * join's own `IS NOT NULL` makes the predicate redundant but it is kept,
 * because a predicate load-bearing by implication is a predicate the next
 * reader has to re-derive.
 *
 * `m.state IN ('handled', 'failed')` is the other half of report-once: a row
 * already moved to `'reported'` is invisible to this query, so a second call
 * finds nothing to do rather than relying on the claim alone to protect it.
 *
 * The four phases named are every phase this classifier can say something
 * about. A job still mid-flight (`execute`, `verify`, `followup`, `remember`,
 * `update`, `plan`, `understand`, `intake`) is not yet a fact to report —
 * see `classifyJob`'s last branch for what happens to a phase outside this
 * set if one ever reaches it some other way.
 */
async function reportCandidates(
  businessId: string,
  db: Queryable,
): Promise<ReportCandidate[]> {
  const { rows } = await db.query<ReportCandidateRow>(
    `SELECT j.job_id, j.phase, j.whatsapp_message_id
       FROM jobs j
       JOIN whatsapp_messages m
         ON m.id = j.whatsapp_message_id AND m.business_id = j.business_id
      WHERE j.business_id = $1
        AND j.whatsapp_message_id IS NOT NULL
        AND m.state IN ('handled', 'failed')
        AND j.phase IN ('closed', 'failed', 'halted', 'await_approval')
      ORDER BY j.updated_at ASC`,
    [businessId],
  );
  return rows.map((row) => ({
    jobId: row.job_id,
    phase: JobPhase.parse(row.phase),
    messageId: row.whatsapp_message_id,
  }));
}

/** The reason on the last `job_steps` row for this job, or `null` if it has none. */
async function lastReason(jobId: string): Promise<string | null> {
  const history = await jobHistory(jobId);
  return history[history.length - 1]?.reason ?? null;
}

interface JobVerdict {
  outcome: ReportOutcome;
  failReason: string | null;
}

/**
 * What actually happened to one job, classified in the order that makes the
 * report honest.
 *
 * 1. Any recorded step carrying `performed: false` → `not_implemented`,
 *    regardless of what the phase says. A plan that drafted or recalled
 *    before it ever reached the step that mattered still has that step's own
 *    honest `false` sitting in the record, and that fact outranks whatever
 *    the job did afterwards.
 * 2. `failed` phase → `failed`, with the last `job_steps.reason`.
 * 3. `await_approval` phase → `awaiting_approval`.
 * 4. A bound plan whose every declared step has a `completed` row →
 *    `performed`.
 * 5. Anything else → `failed`. A job whose record cannot support the claim
 *    that it performed is never reported as having performed — the same
 *    positive rule `closeVerifiedJobs` already applies before it will close
 *    a job at all.
 */
async function classifyJob(
  jobId: string,
  phase: JobPhase,
  businessId: string,
): Promise<JobVerdict> {
  const stored = await loadPlanBody(jobId, { businessId });
  const recorded = stored === null ? [] : await stepResults(jobId, stored.planHash, { businessId });

  if (recorded.some((step) => step.performed === false)) {
    return { outcome: 'not_implemented', failReason: null };
  }

  if (phase === 'failed') {
    return { outcome: 'failed', failReason: await lastReason(jobId) };
  }

  if (phase === 'await_approval') {
    return { outcome: 'awaiting_approval', failReason: null };
  }

  if (stored !== null) {
    const byStep = new Map(recorded.map((step) => [step.stepId, step]));
    const everyStepCompleted = stored.plan.steps.every(
      (step) => byStep.get(step.id)?.status === 'completed',
    );
    if (everyStepCompleted) {
      return { outcome: 'performed', failReason: null };
    }
  }

  return { outcome: 'failed', failReason: await lastReason(jobId) };
}

/**
 * Send the owner one honest sentence for every WhatsApp-opened job that has
 * reached a reportable phase and has not already been reported.
 *
 * Not wired into the scheduler by this task — see the task report for why
 * that wiring is deliberately left to whoever next runs `runWhatsAppDoor`
 * and this function from the same production loop.
 */
export async function reportWhatsAppJobs(options: {
  messenger: BossMessenger;
  businessId?: string;
  dashboardBaseUrl?: string;
}): Promise<ReportResult> {
  const businessId = options.businessId ?? config.businessId;
  const dashboardBaseUrl = options.dashboardBaseUrl ?? DEFAULT_DASHBOARD_BASE_URL;
  const db = getPool();

  const candidates = await reportCandidates(businessId, db);
  let reported = 0;

  for (const candidate of candidates) {
    const verdict = await classifyJob(candidate.jobId, candidate.phase, businessId);

    let text: string;
    if (verdict.outcome === 'not_implemented') {
      text = NOT_IMPLEMENTED_TEXT;
    } else if (verdict.outcome === 'performed') {
      text = PERFORMED_TEXT;
    } else if (verdict.outcome === 'failed') {
      text = failedText(verdict.failReason);
    } else {
      const approvalId = await pendingApprovalForJob(candidate.jobId, { businessId });
      const approvalUrl = approvalId === null ? null : `${dashboardBaseUrl}/a/${approvalId}`;
      text = awaitingApprovalText(approvalUrl);
    }

    // Claimed right before the send — see the module docblock on why
    // classification runs first. A lost race (another pass already claimed
    // this message) is not an error: it means nothing is left to do.
    const claimed = await claimForReport(candidate.messageId, { businessId });
    if (!claimed) continue;

    await options.messenger.send({ text, jobId: candidate.jobId });
    reported += 1;
  }

  return { reported };
}
