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
 * **Two claims, not one — fix round 1, Critical 1.** `await_approval` is NOT
 * terminal (`jobs.ts`'s `terminal` is `closed`/`failed`/`halted` only;
 * `resumeAfterDecision` moves an approved job on to `execute`), but the first
 * version of this module reported it anyway and burned the SAME claim a
 * genuinely closed job needed later: an approval-gated instruction — the
 * common case for anything that costs money — got told "waiting for your
 * approval" once, approved, ran, closed, and the owner never heard the real
 * outcome, because the opening message already read `'reported'`. Migration
 * 038 adds `'reported_interim'`: `claimForReport` (`whatsapp/store.ts`) now
 * takes a `kind`, and `reportWhatsAppJobs` below decides it from the
 * candidate's own PHASE — `await_approval` claims `'interim'`,
 * every terminal phase claims `'terminal'` — never from the classified
 * `ReportOutcome`, so a job that is still genuinely waiting always leaves a
 * terminal report owed, whatever the current sentence happens to say.
 *
 * **Report-once reuses `whatsapp_messages.state`, never a second ledger.**
 * Both markers are migration 036/038's states, and `claimForReport` is the
 * only writer of either.
 *
 * **The claim happens right before the send, not before classification.**
 * Classifying a job is read-only and can be retried for free; claiming
 * cannot — a message moved past its current state is not reconsidered by the
 * next pass for that same claim. Claiming first and then failing to classify
 * would burn a report the owner never actually heard.
 *
 * **`messenger.send` never throws** (`BossMessenger`'s own contract), so
 * nothing here wraps it — a delivery failure is the messenger's own fact to
 * record (`recordAttempt` inside `createBossMessenger` settles the row it
 * wrote to `'failed'`), not this function's to recover from. `reported`
 * below counts CLAIMS, not confirmed deliveries: the claim is made before the
 * send (it has to be, to stay at-most-once under a send whose deadline path
 * admits the call may still be in flight — rolling the claim back on a
 * `{ ok: false }` would risk a duplicate for a message that may have gone out
 * anyway), so a gateway outage consumes every pending report in one pass with
 * nothing left to retry. That is the same at-most-once trade this project
 * makes everywhere a far end might have already acted — not a defect to fix
 * here, but worth stating plainly rather than leaving to "what became of the
 * send is the messenger's business."
 *
 * **One job's unreadable record must not stop every other job's report.**
 * `classifyJob` calls `loadPlanBody`, which throws BY DESIGN on a stored plan
 * that no longer parses — and `reportCandidates` orders oldest-first, so an
 * unparseable plan sitting on the oldest candidate would, without isolation,
 * starve every job behind it forever. `reportWhatsAppJobs` therefore wraps
 * each candidate's own processing and reports failures in `errored` rather
 * than letting one throw end the pass — the same isolation `runDueJobs` and
 * `closeVerifiedJobs` already give each job they touch.
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
  /** Opening messages claimed and sent this pass — interim and terminal alike. */
  reported: number;
  /** Job ids whose own processing threw, isolated so they cost nothing else this pass. */
  errored: string[];
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

export const NOT_IMPLEMENTED_TEXT =
  'סיימתי לטפל בהוראה, אבל חלק מהפעולות בה לא בוצע: עדיין אין לי אפשרות טכנית לבצע אותן באופן אוטומטי. אפשר לראות בדשבורד בדיוק אילו.';

export const PERFORMED_TEXT = 'סיימתי — מה שביקשת בוצע בהצלחה.';

export const FAILED_GENERIC_TEXT = 'הניסיון לבצע את ההוראה נכשל. אפשר לראות פרטים בדשבורד.';

const AWAITING_APPROVAL_GENERIC_TEXT =
  'הפעולה הזו דורשת את האישור שלך לפני שהיא תבוצע. אפשר לאשר אותה מהדשבורד.';

/**
 * Known engine failure codes, mapped to a Hebrew sentence fragment — never
 * the raw English that follows them.
 *
 * `job_steps.reason` is built as `${code} — ${message}` by `execute.ts`'s own
 * transitions (`adapter_threw`, `credential_unavailable`, the five
 * OAuth-derived codes, …), where `message` is frequently English — an error
 * class's own `.message`, raw SMTP text, a credential ref. `verify.ts`'s two
 * disqualifying predicates write a full ENGLISH SENTENCE outright
 * (`outcome unknown for … — the call went out and no authoritative answer
 * came back; nothing confirms it happened`), with no code prefix at all.
 * Fix round 1, Important 4: the first version of this module interpolated
 * `job_steps.reason` into the owner's one sentence verbatim, and its own test
 * passed only because it hand-wrote a Hebrew reason production never emits —
 * "green for the wrong reason", exactly the class CLAUDE.md documents.
 *
 * Deliberately NOT exhaustive. A code missing from this table falls through
 * to `FAILED_GENERIC_TEXT`, which still tells the owner it failed and points
 * at the dashboard — never the raw code or message. That is the positive
 * rule this report already applies everywhere else: an unmapped value is
 * never read as permission to paste it in front of a human.
 */
const FAILURE_REASON_HE: Readonly<Record<string, string>> = {
  adapter_timeout: 'השירות החיצוני לא הגיב בזמן',
  adapter_threw: 'אירעה שגיאה טכנית בביצוע הפעולה',
  channel_unavailable: 'החיבור למערכת החיצונית לא היה זמין',
  credential_unavailable: 'חסרים פרטי התחברות תקינים לביצוע הפעולה',
  oauth_grant_revoked: 'ההרשאה לחיבור בוטלה',
  oauth_refresh_rejected: 'חידוש ההרשאה לחיבור נדחה',
  oauth_misconfigured: 'החיבור אינו מוגדר כראוי',
  oauth_ambiguous_ref: 'הגדרת החיבור אינה חד-משמעית',
  oauth_refresh_transient: 'חידוש ההרשאה לחיבור נכשל זמנית',
  no_adapter_for_system: 'אין חיבור פעיל למערכת הנדרשת',
  delegation_orphaned: 'הבקשה לעזרה מסוכן אחר לא הושלמה',
  delegation_result_corrupted: 'התשובה שהתקבלה מסוכן אחר הייתה פגומה',
  verification_delegated_again: 'תהליך האימות לא הסתיים כראוי',
  verification_answer_missing: 'לא התקבלה תשובה לבדיקה שהתבצעה',
  local_tool_bad_input: 'הנתונים שהועברו לפעולה לא היו תקינים',
};

/**
 * The leading machine code off a `job_steps.reason` string built as
 * `${code} — ${message}` — or `null` when the separator is absent, which
 * `FAILURE_REASON_HE` is guaranteed never to have a key matching anyway.
 */
function leadingCode(reason: string): string | null {
  const separator = reason.indexOf(' — ');
  return separator === -1 ? null : reason.slice(0, separator);
}

/**
 * Branch 2's text only — see `classifyJob`. Never called for branch 5: a
 * non-failure reason (`'closed after the curator pass'`, say) is not this
 * function's to describe as a failure cause (fix round 1, Minor 6).
 */
export function failedText(reason: string | null): string {
  if (reason === null) return FAILED_GENERIC_TEXT;
  const code = leadingCode(reason);
  const mapped = code === null ? undefined : FAILURE_REASON_HE[code];
  return mapped === undefined ? FAILED_GENERIC_TEXT : `הניסיון לבצע את ההוראה נכשל: ${mapped}.`;
}

export function awaitingApprovalText(approvalUrl: string | null): string {
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
 * worth telling the owner about, whose opening message is not already
 * carrying the real, final report.
 *
 * `whatsapp_message_id IS NOT NULL` is what excludes every job that did not
 * come from this door — `linkWhatsAppMessage` is the only writer of that
 * column, and it is called only for a job the door actually opened. The
 * join's own `IS NOT NULL` makes the predicate redundant but it is kept,
 * because a predicate load-bearing by implication is a predicate the next
 * reader has to re-derive.
 *
 * `m.state IN ('handled', 'failed', 'reported_interim')` is report-once at
 * the candidate level, for BOTH claims: a row already at `'reported'` is
 * invisible (the real answer is already told); `'reported_interim'` stays
 * VISIBLE on purpose — that job already got the interim notice and is
 * exactly the one still owed a terminal one.
 *
 * The four phases named are every phase this classifier can say something
 * about. A job still mid-flight (`execute`, `verify`, `followup`, `remember`,
 * `update`, `plan`, `understand`, `intake`) is not yet a fact to report, and
 * this predicate is the ONLY thing that keeps such a job out — fix round 1,
 * Important 3 found it untested: deleting this line fails nothing in the
 * suite that existed then, because every test either used a terminal/awaiting
 * job or an unlinked one. See `whatsapp-report.test.ts`'s own test for a
 * linked job left in `execute`, and the matching mutation in the task report.
 *
 * `'halted'` has no production writer today (`grep -rn "to: 'halted'" src/`
 * returns nothing — a kill-switch halt is not wired up to move a job there
 * yet). Listed anyway because the phase exists in `JobPhase` and is
 * legitimately terminal; if a halt is ever wired, a halted job whose steps
 * all happened to complete would be reported `performed`, which may or may
 * not be the honest reading of a kill-switch stop — a decision for whoever
 * wires it, not a defect of this predicate today.
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
        AND m.state IN ('handled', 'failed', 'reported_interim')
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

export interface JobVerdict {
  outcome: ReportOutcome;
  /** Branch 2 only. `null` everywhere else — see `failedText`'s own docblock on branch 5. */
  failReason: string | null;
  /** Branch 3 only — the live approval this job is actually waiting behind. */
  approvalId: string | null;
}

/**
 * What actually happened to one job, classified in the order that makes the
 * report honest. Exported so a test can assert the `ReportOutcome` directly
 * rather than scraping prose (fix round 1, item 7).
 *
 * 1. Any recorded step carrying `performed: false` → `not_implemented`,
 *    regardless of what the phase says. A plan that drafted or recalled
 *    before it ever reached the step that mattered still has that step's own
 *    honest `false` sitting in the record, and that fact outranks whatever
 *    the job did afterwards.
 * 2. `failed` phase → `failed`, with the last `job_steps.reason` (mapped to
 *    Hebrew by `failedText`, never forwarded raw).
 * 3. `await_approval` phase WITH a live `pending` approval row →
 *    `awaiting_approval`. **Fix round 1, Important 3:** a `await_approval`
 *    phase with NO live row (the approval was decided or expired between the
 *    candidate read and this lookup — `pendingApprovalForJob`'s own docblock)
 *    is NOT reported as awaiting anything: that wait has already passed, and
 *    continuing to say so would describe a state the job is no longer in.
 *    Falls through to 4/5 instead, same as any other phase would.
 * 4. A bound plan whose every declared step has a `completed` row →
 *    `performed`.
 * 5. Anything else → `failed`, with `failReason: null` (generic text) —
 *    never the last `job_steps.reason`: for a `closed`/`halted` job that
 *    reason is routinely a non-failure sentence (`'closed after the curator
 *    pass'`), and attributing it as a failure cause would be its own
 *    dishonesty (fix round 1, Minor 6). A job whose record cannot support
 *    the claim that it performed is never reported as having performed — the
 *    same positive rule `closeVerifiedJobs` already applies before it will
 *    close a job at all.
 */
export async function classifyJob(
  jobId: string,
  phase: JobPhase,
  businessId: string,
): Promise<JobVerdict> {
  const stored = await loadPlanBody(jobId, { businessId });
  const recorded = stored === null ? [] : await stepResults(jobId, stored.planHash, { businessId });

  if (recorded.some((step) => step.performed === false)) {
    return { outcome: 'not_implemented', failReason: null, approvalId: null };
  }

  if (phase === 'failed') {
    return { outcome: 'failed', failReason: await lastReason(jobId), approvalId: null };
  }

  if (phase === 'await_approval') {
    const approvalId = await pendingApprovalForJob(jobId, { businessId });
    if (approvalId !== null) {
      return { outcome: 'awaiting_approval', failReason: null, approvalId };
    }
    // No live row: the wait this phase describes has already passed one way
    // or another. Fall through to the positive check below rather than
    // reporting a state that is no longer true.
  }

  if (stored !== null) {
    const byStep = new Map(recorded.map((step) => [step.stepId, step]));
    // Fix round 1, Minor 7 (recorded, not fixed — see below). This only
    // checks `status === 'completed'`, not `performed === true` on every row
    // — deliberately: a `completed` row written before migration 037 carries
    // `performed = NULL`, and requiring `=== true` here would wrongly fail
    // every such legacy row, including non-WhatsApp jobs this report never
    // even looks at. The exposure is structurally narrow regardless: only a
    // job with `whatsapp_message_id` set is a candidate at all, and that
    // column shipped in migration 036 on this same branch, so no pre-037
    // `completed` row can belong to a WhatsApp-opened job in practice — the
    // only window was this branch's own development, before 037 landed. Not
    // worth a data migration or a stricter check that fails real jobs to
    // close a window that is already shut.
    const everyStepCompleted = stored.plan.steps.every(
      (step) => byStep.get(step.id)?.status === 'completed',
    );
    if (everyStepCompleted) {
      return { outcome: 'performed', failReason: null, approvalId: null };
    }
  }

  return { outcome: 'failed', failReason: null, approvalId: null };
}

/** The text of one report, given what `classifyJob` decided. */
function composeText(verdict: JobVerdict, dashboardBaseUrl: string): string {
  switch (verdict.outcome) {
    case 'not_implemented':
      return NOT_IMPLEMENTED_TEXT;
    case 'performed':
      return PERFORMED_TEXT;
    case 'failed':
      return failedText(verdict.failReason);
    case 'awaiting_approval': {
      const approvalUrl =
        verdict.approvalId === null ? null : `${dashboardBaseUrl}/a/${verdict.approvalId}`;
      return awaitingApprovalText(approvalUrl);
    }
  }
}

/**
 * Send the owner one honest sentence for every WhatsApp-opened job that has
 * reached a reportable phase and still owes a report.
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
  const errored: string[] = [];

  for (const candidate of candidates) {
    // One candidate's own throw must not end the pass for every candidate
    // behind it — see the module docblock. `loadPlanBody` throws by design
    // on a plan that no longer parses, and candidates are oldest-first, so
    // without this a single unreadable job would sit first forever and
    // starve every WhatsApp job behind it.
    try {
      const verdict = await classifyJob(candidate.jobId, candidate.phase, businessId);
      const text = composeText(verdict, dashboardBaseUrl);

      // The claim's KIND follows the candidate's own PHASE, never the
      // classified outcome — fix round 1, Critical 1. A job read as
      // `await_approval` has not reached a terminal phase regardless of what
      // today's sentence says (branch 1 can still fire "not_implemented" on
      // a plan that is simultaneously parked on a later step's approval
      // card), so it must leave a terminal report owed; every terminal phase
      // claims the real, final one.
      const claimKind = candidate.phase === 'await_approval' ? 'interim' : 'terminal';

      // Claimed right before the send — see the module docblock on why
      // classification runs first. A lost race (another pass already made
      // this claim) is not an error: it means nothing is left to do.
      const claimed = await claimForReport(candidate.messageId, claimKind, { businessId });
      if (!claimed) continue;

      await options.messenger.send({ text, jobId: candidate.jobId });
      reported += 1;
    } catch {
      errored.push(candidate.jobId);
    }
  }

  return { reported, errored };
}
