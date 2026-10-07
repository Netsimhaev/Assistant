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
 * would tell the owner a CRM order was entered when nothing was. The
 * `recorded.some(performed === false)` check below exists only to refuse
 * that shortcut — see migration 037 and `StepEffect.performed` (`execute.ts`)
 * for where the fact it reads is actually written down.
 *
 * **Two claims, not one — fix round 1, Critical 1.** `await_approval` is NOT
 * terminal (`jobs.ts`'s `terminal` is `closed`/`failed`/`halted` only;
 * `resumeAfterDecision` moves an approved job on to `execute`), but the first
 * version of this module reported it anyway and burned the SAME claim a
 * genuinely closed job needed later. Migration 038 adds `'reported_interim'`:
 * `claimForReport` (`whatsapp/store.ts`) takes a `kind`, and
 * `reportWhatsAppJobs` below decides it from the candidate's own PHASE —
 * `await_approval` claims `'interim'`, every terminal phase claims
 * `'terminal'` — never from the classified `ReportOutcome`.
 *
 * **The CLAIM following the phase is not enough on its own — fix round 2,
 * item 1.** The claim kind was already phase-driven, but the TEXT still came
 * from the classifier alone, and the two could disagree: a job sitting in
 * `await_approval` with an earlier step's `performed: false` row produced
 * `NOT_IMPLEMENTED_TEXT` — a final-sounding "I finished, but…" sentence —
 * while a card was still silently waiting, with no link, followed later by a
 * second, different final sentence once the job actually closed. Two
 * final-sounding sentences for one instruction is exactly the dishonesty this
 * whole report exists to prevent, one level up from where round 1 found it.
 * **`classifyJob` therefore decides `await_approval` FIRST, unconditionally —
 * before the `performed: false` check — and that decision is binary:** a live
 * `pending` row → `awaiting_approval` with the link (`JobVerdict.status ===
 * 'report'`); no live row → `JobVerdict.status === 'defer'`, meaning send
 * NOTHING this pass. The normal cause of "no live row while the phase still
 * reads `await_approval`" is a decided-but-not-yet-resumed race
 * (`decide` commits, `resumeAfterDecision` has not run yet) or an
 * expired-but-not-yet-swept one (`expireOverdue` has not run yet) — both
 * transient by construction, both resolved by the next scheduler pass. A
 * deferral is therefore the honest answer: there is nothing true to say about
 * this job RIGHT NOW. `ReportResult.deferred` counts it, so a job that is
 * deferred because the cause is pathological instead — a resume that crashed
 * for good — is counted rather than silently never reported, which is the
 * one outcome this task may not produce.
 *
 * **A gate denial is not a failure — fix round 2, item 2.** Every action
 * class sits at `draft_only` today, so `evaluateToolCall`'s own `deny(...)`
 * (`policy/engine.ts`) — not an adapter throwing, not a timeout — is the
 * DOMINANT way a WhatsApp-opened job reaches `failed`. `"נכשל"` ("it failed")
 * is the wrong sentence for that: the assistant did not break, she is not yet
 * PERMITTED to act on this without a person. `classifyJob`'s `failed`-phase
 * branch recognises the gate's own fixed deny codes (`isGateDenialCode`,
 * below) and reports `'not_permitted'` with its own Hebrew sentence instead
 * of folding it into the generic failure path.
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

export type ReportOutcome =
  | 'performed'
  | 'not_implemented'
  | 'failed'
  | 'not_permitted'
  | 'awaiting_approval';

export interface ReportResult {
  /** Opening messages claimed and sent this pass — interim and terminal alike. */
  reported: number;
  /**
   * Candidates read but deliberately NOT sent this pass — fix round 2, item
   * 1. Always a job read as `await_approval` with no live `pending` row: a
   * transient race (decided-not-yet-resumed, or expired-not-yet-swept) that
   * the next pass resolves on its own. Counted, never silent, so a resume
   * that crashed for good is visible rather than indistinguishable from
   * nothing having happened.
   */
  deferred: number;
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

/**
 * Fix round 2, item 2. A gate denial is not a failure — `evaluateToolCall`
 * refused on purpose, under a policy the owner himself signed (or has not yet
 * raised), and saying "נכשל" ("it failed") claims the assistant broke when
 * she did exactly what she was told to do: not act without more permission.
 * One sentence for the whole class, not a translation per code — see
 * `isGateDenialCode`'s own docblock for why a per-code sentence is not
 * attempted here.
 */
export const NOT_PERMITTED_TEXT =
  'לא ביצעתי את הפעולה הזו: היא מחייבת הרשאה שעדיין לא ניתנה לי לפעול בה לבד. ' +
  'אפשר לבדוק את ההרשאות בדשבורד, או לאשר אותה שם.';

const AWAITING_APPROVAL_GENERIC_TEXT =
  'הפעולה הזו דורשת את האישור שלך לפני שהיא תבוצע. אפשר לאשר אותה מהדשבורד.';

/**
 * `policy/engine.ts`'s own `deny(...)` codes (`domain/policy.ts`'s
 * `DENY_CODES`) — fixed strings a charter cannot change. A job whose `failed`
 * reason carries one of these codes was stopped by the GATE, not by a
 * breakage — see `NOT_PERMITTED_TEXT`.
 *
 * `'quiet_hours'` is deliberately absent: both of `engine.ts`'s own deny
 * sites for it additionally require `bundle.quietHours !== null`, and that
 * denial moves a job to `followup`, never to `failed` (`execute.ts`'s own
 * branch for it) — so it never reaches this classifier at all.
 *
 * `'recipient_unreadable'` is in this set but `engine.ts` never actually
 * emits it — `DENY_CODES.recipientUnreadable` is declared in
 * `domain/policy.ts` with no corresponding `deny(...)` call anywhere. Kept
 * anyway: a code that never arrives is a dead, harmless, POSITIVE entry —
 * the failure direction this table cannot have is a code that DOES arrive
 * and is missing, never the reverse. Recorded here so the next reader does
 * not mistake the dead entry for a live one and go looking for where it
 * fires.
 *
 * **Fix round 3 — `forbidden.id` is NOT the exception it looks like, and
 * fix round 2's docblock here was wrong to say otherwise.** `compile.ts`
 * writes `` id: `forbidden:${rule.id}` `` for every charter rule
 * (`compileRules`), and `engine.ts` reaches `deny(forbidden.id, …)` with a
 * comment, two lines above that call, stating exactly this: *"`forbidden.id`
 * already carries its namespace: the compiler prefixes every rule id with
 * its kind … Prefixing again here produced `forbidden:forbidden:<id>`."*
 * So every forbidden-rule denial DOES carry a fixed prefix — `forbidden:` —
 * regardless of which rule or which charter fired it, and belongs in the
 * prefix group below exactly like `budget_exceeded`/`risk_blocked:`. Closing
 * this needed no charter loading and no rule-id matching, which is what the
 * previous version of this docblock claimed it would take — a false
 * "cannot be made so" is worse than the gap it described, because it tells
 * the next reader to stop looking rather than to open `engine.ts`.
 *
 * Three entries below `GATE_DENY_CODES` are prefixes rather than exact
 * codes, because the gate appends a dynamic suffix to them: `budget_exceeded`
 * (`:discount`, `:per_action_class:<class>`, `:single_action`,
 * `:supplier:<id>`, `:daily`, `:monthly` — `policy/budget.ts`),
 * `risk_blocked:<actionId>` (`policy/engine.ts`), and `forbidden:<ruleId>`
 * (`charter/compile.ts`, as above). `startsWith` is deliberately NOT used
 * for the exact codes in `GATE_DENY_CODES` itself: a prefix check there
 * would silently swallow any future code that happens to share a prefix
 * with one of them.
 */
const GATE_DENY_CODES: ReadonlySet<string> = new Set([
  'kill_switch_active',
  'stale_policy',
  'autonomy_forbidden',
  'draft_only:persist_as_draft',
  'do_not_contact',
  'amount_unreadable',
  'recipient_unreadable', // never actually emitted — see this set's own docblock.
  'tool_not_allowlisted',
  'delegation_not_permitted',
]);

export function isGateDenialCode(code: string): boolean {
  return (
    GATE_DENY_CODES.has(code) ||
    code.startsWith('budget_exceeded') ||
    code.startsWith('risk_blocked:') ||
    code.startsWith('forbidden:')
  );
}

/**
 * Known engine failure codes, mapped to a Hebrew sentence fragment — never
 * the raw English that follows them.
 *
 * `job_steps.reason` is built as `${code} — ${message}` by `execute.ts`'s own
 * transitions, where `message` is frequently English — an error class's own
 * `.message`, raw SMTP text, a credential ref. `verify.ts`'s two
 * disqualifying predicates write a full ENGLISH SENTENCE outright, with no
 * code prefix at all. Fix round 1, Important 4: the first version of this
 * module interpolated `job_steps.reason` into the owner's one sentence
 * verbatim, and its own test passed only because it hand-wrote a Hebrew
 * reason production never emits — "green for the wrong reason".
 *
 * **Fix round 2, item 3 — three groups, named by where they actually come
 * from, because the review checked this table against what the engine
 * actually emits rather than against itself:**
 *
 * 1. `execute.ts`'s own classification codes, as before (14 entries). Three
 *    are marked `retryable` in `StepChannelError` and therefore move the job
 *    to `followup`/`unknown` rather than `failed` — they rarely reach this
 *    branch, and are kept (not removed) because `unknown` → `failed` is the
 *    terminal path once such a step's own idempotent resume gives up for
 *    good at some later point, however that comes to pass.
 * 2. The one wired outbound adapter's own eight codes
 *    (`adapters/mail.ts:124-256`, raised at `run-plan.ts:762` via
 *    `StepChannelError`, reaching `job_steps.reason` through the identical
 *    `${code} — ${message}` shape). `aborted` and `transport_error` are the
 *    two retryable ones here, same caveat as above.
 * 3. `run-due.ts`'s own plan-level rejections, keyed under an explicit
 *    `run_due:` namespace that `leadingCode` manufactures — see its own
 *    docblock for why `run_due: ${code}` cannot be split on `' — '` at all.
 *
 * `delegation_refused:<code>` (`local-tools.ts`'s `agent.request_help`) is
 * handled separately in `failedText`, as a PREFIX match rather than a table
 * entry: the code after the colon is `requestHelp`'s own refusal reason
 * (eight distinct values, `delegate.ts`), and none of them change what the
 * owner needs to hear — a helper agent declined, full stop.
 *
 * Deliberately NOT exhaustive even within these three groups. A code missing
 * from this table falls through to `FAILED_GENERIC_TEXT`, which still tells
 * the owner it failed and points at the dashboard — never the raw code or
 * message.
 */
const FAILURE_REASON_HE: Readonly<Record<string, string>> = {
  // execute.ts's own adapter/channel classification.
  adapter_timeout: 'השירות החיצוני לא הגיב בזמן', // retryable
  adapter_threw: 'אירעה שגיאה טכנית בביצוע הפעולה',
  channel_unavailable: 'החיבור למערכת החיצונית לא היה זמין', // retryable
  credential_unavailable: 'חסרים פרטי התחברות תקינים לביצוע הפעולה',
  oauth_grant_revoked: 'ההרשאה לחיבור בוטלה',
  oauth_refresh_rejected: 'חידוש ההרשאה לחיבור נדחה',
  oauth_misconfigured: 'החיבור אינו מוגדר כראוי',
  oauth_ambiguous_ref: 'הגדרת החיבור אינה חד-משמעית',
  oauth_refresh_transient: 'חידוש ההרשאה לחיבור נכשל זמנית', // retryable
  no_adapter_for_system: 'אין חיבור פעיל למערכת הנדרשת',
  delegation_orphaned: 'הבקשה לעזרה מסוכן אחר לא הושלמה',
  delegation_result_corrupted: 'התשובה שהתקבלה מסוכן אחר הייתה פגומה',
  verification_delegated_again: 'תהליך האימות לא הסתיים כראוי',
  verification_answer_missing: 'לא התקבלה תשובה לבדיקה שהתבצעה',
  local_tool_bad_input: 'הנתונים שהועברו לפעולה לא היו תקינים',

  // The one wired outbound adapter's own eight codes (adapters/mail.ts).
  unsupported_tool: 'הכלי שנבחר לא מתאים לחיבור הזה',
  aborted: 'השליחה בוטלה לפני שהושלמה', // retryable
  credential_missing: 'אין פרטי התחברות לחיבור — ההודעה לא נשלחה',
  no_recipient: 'לא נמצאה כתובת תקינה לשליחה',
  message_incomplete: 'להודעה חסר נושא או תוכן',
  send_rejected: 'השרת החיצוני דחה את ההודעה',
  transport_error: 'אירעה תקלת תקשורת בשליחה', // retryable
  delivery_unknown: 'לא ניתן לאשר אם ההודעה נשלחה בהצלחה',

  // run-due.ts's own plan-level rejections, under the `run_due:` namespace
  // `leadingCode` manufactures.
  'run_due:no_plan_bound': 'לא נמצאה תוכנית פעולה למשימה',
  'run_due:malformed_plan': 'התוכנית שנבנתה לא הייתה תקינה',
  'run_due:tool_not_allowlisted': 'הפעולה המתוכננת אינה מורשית לסוכן שתכנן אותה',
  'run_due:action_class_mismatch': 'הפעולה בפועל לא תאמה את מה שתוכנן',
  'run_due:no_channel_for_tool': 'אין חיבור מוגדר לפעולה הזו',
  'run_due:ambiguous_channel': 'יש יותר מחיבור אחד אפשרי לפעולה הזו',
  'run_due:no_adapter_for_system': 'אין חיבור פעיל למערכת הנדרשת',
  'run_due:plan_changed_mid_flight': 'התוכנית השתנתה באמצע הביצוע',
  'run_due:job_not_executable': 'המשימה לא הייתה במצב שמאפשר ביצוע',
};

/**
 * The leading machine code off a `job_steps.reason` string, across the two
 * shapes this codebase actually writes it in.
 *
 * `run-due.ts`'s own rejections are the SPECIAL case, checked first: the
 * whole reason IS `run_due: ${code}` — colon-space, and nothing else ever
 * follows it, so `indexOf(' — ')` below would find no dash at all and this
 * would (and once did) silently return `null`, sending every `run_due:`
 * failure to the generic text with no chance of a mapping. The namespaced
 * key this returns (`run_due:${code}`, no space) is what `FAILURE_REASON_HE`
 * is keyed under for that group.
 *
 * Everything else — `execute.ts`'s own transitions, and
 * `delegation_refused:<code>` riding inside one of them as the `code` itself
 * — uses `${code} — ${message}`, split on the em dash.
 */
function leadingCode(reason: string): string | null {
  const RUN_DUE_PREFIX = 'run_due: ';
  if (reason.startsWith(RUN_DUE_PREFIX)) {
    return `run_due:${reason.slice(RUN_DUE_PREFIX.length)}`;
  }
  const dash = reason.indexOf(' — ');
  return dash === -1 ? null : reason.slice(0, dash);
}

/**
 * Branch "failed" text only — see `classifyJob`. Never called for the
 * catch-all branch: a non-failure reason (`'closed after the curator pass'`,
 * say) is not this function's to describe as a failure cause (fix round 1,
 * Minor 6). Never called when `isGateDenialCode` already matched — that
 * outcome is `'not_permitted'`, not `'failed'`, and carries no reason at all.
 */
export function failedText(reason: string | null): string {
  if (reason === null) return FAILED_GENERIC_TEXT;
  const code = leadingCode(reason);
  if (code === null) return FAILED_GENERIC_TEXT;
  // `delegation_refused:<code>` — a prefix, not a table entry; see
  // `FAILURE_REASON_HE`'s own docblock for why.
  if (code.startsWith('delegation_refused:')) {
    return `הניסיון לבצע את ההוראה נכשל: הבקשה לעזרה מסוכן אחר נדחתה.`;
  }
  const mapped = FAILURE_REASON_HE[code];
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

/**
 * What one job's candidacy resolved to.
 *
 * `'defer'` — fix round 2, item 1 — means exactly one thing: a job read as
 * `await_approval` with no live `pending` approval row right now. Nothing is
 * sent, nothing is claimed, and the candidate is read again next pass; see
 * the module docblock for why that is the honest answer rather than a guess.
 * Every other case is `'report'`, carrying the sentence to send.
 */
export type JobVerdict =
  | { status: 'report'; outcome: ReportOutcome; failReason: string | null; approvalId: string | null }
  | { status: 'defer' };

/**
 * What actually happened to one job, classified in the order that makes the
 * report honest. Exported so a test can assert the `ReportOutcome` directly
 * rather than scraping prose (fix round 1, item 7).
 *
 * 0. `await_approval` phase, checked FIRST and UNCONDITIONALLY — fix round 2,
 *    item 1. A live `pending` row → `awaiting_approval` with the link. No
 *    live row → `defer`. Nothing below this point ever runs for such a job:
 *    neither "not performed" nor "finished" nor "failed" may describe a job
 *    that has not reached a phase those words apply to, however the record
 *    looks otherwise. This is what keeps round 1's own rule — "waiting for
 *    approval" must not describe a wait that already passed — from
 *    colliding with its mirror: "finished"/"failed" must not describe a wait
 *    that has not happened yet.
 * 1. Any recorded step carrying `performed: false` → `not_implemented`,
 *    regardless of what the phase says otherwise. A plan that drafted or
 *    recalled before it ever reached the step that mattered still has that
 *    step's own honest `false` sitting in the record, and that fact outranks
 *    whatever the job did afterwards — for every phase except `await_approval`,
 *    which branch 0 above already took off the table.
 * 2. `failed` phase → either `not_permitted` (the reason's leading code is
 *    one of `policy/engine.ts`'s own gate-denial codes — fix round 2, item 2)
 *    or `failed` with the last `job_steps.reason` (mapped to Hebrew by
 *    `failedText`, never forwarded raw).
 * 3. A bound plan whose every declared step has a `completed` row →
 *    `performed`.
 * 4. Anything else → `failed`, with `failReason: null` (generic text) —
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
  if (phase === 'await_approval') {
    const approvalId = await pendingApprovalForJob(jobId, { businessId });
    if (approvalId !== null) {
      return { status: 'report', outcome: 'awaiting_approval', failReason: null, approvalId };
    }
    // No live row: the wait this phase describes has either already passed
    // (decided, not yet resumed) or is about to be swept (expired, not yet
    // reaped) — both transient, both resolved by the next pass. Nothing
    // true to say about this job right now.
    return { status: 'defer' };
  }

  const stored = await loadPlanBody(jobId, { businessId });
  const recorded = stored === null ? [] : await stepResults(jobId, stored.planHash, { businessId });

  if (recorded.some((step) => step.performed === false)) {
    return { status: 'report', outcome: 'not_implemented', failReason: null, approvalId: null };
  }

  if (phase === 'failed') {
    const reason = await lastReason(jobId);
    const code = reason === null ? null : leadingCode(reason);
    if (code !== null && isGateDenialCode(code)) {
      return { status: 'report', outcome: 'not_permitted', failReason: null, approvalId: null };
    }
    return { status: 'report', outcome: 'failed', failReason: reason, approvalId: null };
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
      return { status: 'report', outcome: 'performed', failReason: null, approvalId: null };
    }
  }

  return { status: 'report', outcome: 'failed', failReason: null, approvalId: null };
}

/** The text of one report, given what `classifyJob` decided — the `'report'` status only. */
function composeText(
  verdict: Extract<JobVerdict, { status: 'report' }>,
  dashboardBaseUrl: string,
): string {
  switch (verdict.outcome) {
    case 'not_implemented':
      return NOT_IMPLEMENTED_TEXT;
    case 'performed':
      return PERFORMED_TEXT;
    case 'not_permitted':
      return NOT_PERMITTED_TEXT;
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
 * Wired into the scheduler by Task 10 (`scheduler.ts`'s `schedulerPass`),
 * right after `closeVerifiedJobs` — see that call site's own comment, and
 * `SchedulerPassResult.whatsappReport`, for why that ordering is load-bearing
 * rather than incidental.
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
  let deferred = 0;
  const errored: string[] = [];

  for (const candidate of candidates) {
    // One candidate's own throw must not end the pass for every candidate
    // behind it — see the module docblock. `loadPlanBody` throws by design
    // on a plan that no longer parses, and candidates are oldest-first, so
    // without this a single unreadable job would sit first forever and
    // starve every WhatsApp job behind it.
    try {
      const verdict = await classifyJob(candidate.jobId, candidate.phase, businessId);
      if (verdict.status === 'defer') {
        deferred += 1;
        continue;
      }
      const text = composeText(verdict, dashboardBaseUrl);

      // The claim's KIND follows the candidate's own PHASE, never the
      // classified outcome — fix round 1, Critical 1. A job read as
      // `await_approval` has not reached a terminal phase regardless of what
      // today's sentence says, so it must leave a terminal report owed;
      // every terminal phase claims the real, final one. (A `defer`
      // verdict never reaches here at all — see above — so this candidate
      // is always either awaiting-approval-with-a-link or genuinely
      // terminal by the time a claim is attempted.)
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

  return { reported, deferred, errored };
}
