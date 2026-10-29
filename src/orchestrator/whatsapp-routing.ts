/**
 * Which of three things an inbound message from the owner is: the answer to
 * a question he was asked, his own statement that an instruction is finished,
 * or a new instruction.
 *
 * **The owner's rule, in his words:** "הוראה לא יכולה להיסגר עד שהבוס לא
 * אומר שהמשימה נסגרת (במילים שלו) או שהעוזרת האישית מודיעה על 'בוצע',
 * 'נכשל' או משהו שקשור לסוף משימה. כל עוד אין אמירה ברורה של אחד הצדדים —
 * ההוראה עדיין לא נסגרה." And his routing decision: if a question is open,
 * the next message is its answer; otherwise the message is a new
 * instruction.
 *
 * **What is open is DERIVED, never stored a second time.** `pendingQuestions`
 * (`src/governance/instructions.ts`) already answers "what is open" from two
 * positive conditions — the job sits in `understand`, and the answer is still
 * missing — and this module adds no third place for that fact to live. No new
 * table, no new column, no counter kept beside the source. That is this
 * project's own rule (see `CLAUDE.md` on `autonomy_ramp`'s deliberately empty
 * `samples`/`approved_without_edit` columns, and on `agreementFor` being
 * re-derived on every evaluation): a second copy of a fact can drift from the
 * first with nobody noticing, and the drift is silent in exactly the
 * direction that matters — a message read as an answer to a question that is
 * no longer open.
 *
 * **Scoped to this channel, positively.** `pendingQuestions`'s
 * `channel: 'whatsapp'` narrowing is what keeps a question raised on the
 * DASHBOARD from swallowing the owner's next WhatsApp message: he was never
 * asked that question over WhatsApp, so he has no reason to think his next
 * message is being read as its answer. The narrowing reads
 * `jobs.whatsapp_message_id`, whose only writer is `linkWhatsAppMessage`.
 *
 * **The cost of the owner's chosen rule, stated plainly because he chose it
 * knowing: a genuinely new instruction sent while a question is open WILL be
 * consumed as an answer.** That is the right default — the common case by far
 * is that an answer follows a question — and the alternative (asking him
 * every time which it was) is the nagging the whole channel exists to avoid.
 * Three things bound the cost, and none of them is a guess:
 *
 *   1. The window. Past `WHATSAPP_QUESTION_WINDOW_MINUTES` (default 30) the
 *      question stops consuming messages at all. A question he has forgotten
 *      he was asked cannot swallow tomorrow's instruction.
 *   2. The acknowledgement always says which reading was chosen (spec §5.4:
 *      "האישור אומר תמיד איזו פרשנות נבחרה"), quoting the previous request
 *      when it joined one. A wrong reading is visible before anything goes
 *      out, not afterwards.
 *   3. When the re-run on the joined text comes back `needs_answer` or
 *      `refused` AGAIN, that is the signal the message was not an answer —
 *      and the owner is told so in plain Hebrew, with what to do about it,
 *      rather than being left with a nonsense plan and no explanation.
 *
 * **Two or more open questions is a refusal to guess, not a coin toss.**
 * Deciding which question an answer belongs to is the same class of error as
 * deciding which רונית the owner meant, and `resolveContacts` already refuses
 * that one: "כהן אחד נפתר בשקט; כמה כהנים עוצרים ושואלים". A value this door
 * could not read is never a permissive value. The refusal names an exit that
 * exists from WhatsApp itself (a closure word) as well as the one on the
 * dashboard, so the owner is never told only "go elsewhere" — which, with
 * two questions open, would make every subsequent WhatsApp message meet the
 * same refusal with nothing he could type to escape it.
 *
 * **Closure is a fixed verb list, never a model's judgement** — see
 * `src/governance/closure-command.ts` for the list and for why cancel verbs
 * are excluded from it.
 */
import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { isClosureCommand, SUGGESTED_CLOSURE_VERB } from '../governance/closure-command.js';
import {
  claimAnswer,
  pendingQuestions,
  type InstructionRecord,
} from '../governance/instructions.js';
import { stripBidiControls } from '../util/bidi.js';
import { claimForReport } from '../whatsapp/store.js';
import { transition, whatsAppMessageOf } from './jobs.js';

/**
 * What this message is. A closed union, so the door's own handling of it is
 * exhaustive rather than a chain of ifs with an implicit fallthrough.
 *
 * `staleOpen` rides `'new'` alone: it is the count of questions still open on
 * this channel that fell OUTSIDE the window, and it exists so the
 * acknowledgement can say they are still waiting. Without it, a question that
 * aged past the window would go from "answerable" to permanently unmentioned
 * on the surface the owner actually reads — the same silence this whole task
 * exists to remove, one window later.
 */
export type WhatsAppRoute =
  | { kind: 'new'; staleOpen: number }
  | { kind: 'answer'; instruction: InstructionRecord }
  | { kind: 'closure'; open: readonly InstructionRecord[] }
  | { kind: 'ambiguous'; open: readonly InstructionRecord[] };

/**
 * Whether a question is still answerable.
 *
 * Three positive conditions, every one of which must hold: the window must be
 * switched on, the stored moment must be readable, and the elapsed time must
 * fit inside it.
 *
 * **`windowMinutes <= 0` is checked first and on its own**, because `0` is a
 * legal setting that means "no message is ever read as an answer" (see
 * `config.ts`). Without this clause a row created in the same millisecond
 * would satisfy `0 <= 0` and be answered under a switched-off window.
 *
 * **An unreadable timestamp is outside the window, never inside.** Same rule
 * as everywhere else here: a value we could not read is never the permissive
 * one. The consequence of this branch firing is that the message routes as a
 * new instruction — today's behaviour — rather than being joined to a
 * question whose age is unknown.
 *
 * **The moment measured is the INSTRUCTION's `created_at`, not the question's
 * own**, because the question has no timestamp of its own: `recordQuestion`
 * writes a column on the row `saveInstruction` just inserted, inside the same
 * `runInstruction` call. For the identity question those two writes are
 * milliseconds apart; for the planner's own clarifying question they are one
 * model call apart — seconds, occasionally tens of seconds. Both are
 * immaterial against a 30-minute window, and the error is in the safe
 * direction in any case: the window measured this way is slightly SHORTER
 * than nominal, so it expires early and never late.
 *
 * **The clock is the app's, the timestamp is the database's.** A single-host
 * deployment makes the skew sub-second against a window of minutes, and
 * unlike `approval_requests.expires_at` — which is compared in SQL because it
 * decides whether an authorisation may still be spent — nothing is authorised
 * by this window. Both directions of error are benign: too late routes as a
 * new instruction (today's behaviour), and too early cannot happen without a
 * clock running backwards.
 */
function withinQuestionWindow(
  record: InstructionRecord,
  nowMs: number,
  windowMinutes: number,
): boolean {
  if (windowMinutes <= 0) return false;
  const askedMs = Date.parse(record.createdAt);
  if (Number.isNaN(askedMs)) return false;
  return nowMs - askedMs <= windowMinutes * 60_000;
}

/**
 * The clarifying questions open on WhatsApp that a message arriving now could
 * answer: `pendingQuestions` on this channel, inside the window — exactly the
 * set `decideWhatsAppRoute` calls `answerable`. Read-only.
 *
 * Exported for the boss-command confirm reader's collision rule
 * (`whatsapp-door.ts`, spec §10.11): a "כן" with a confirmation AND a
 * clarifying question open cannot say which it answers.
 */
export async function answerableWhatsAppQuestions(input: {
  businessId: string;
  now?: number;
  windowMinutes?: number;
  db?: Queryable;
}): Promise<InstructionRecord[]> {
  const nowMs = input.now ?? Date.now();
  const windowMinutes = input.windowMinutes ?? config.whatsappQuestionWindowMinutes;
  const open = await pendingQuestions({
    businessId: input.businessId,
    channel: 'whatsapp',
    ...(input.db !== undefined ? { db: input.db } : {}),
  });
  return open.filter((record) => withinQuestionWindow(record, nowMs, windowMinutes));
}

/**
 * Reads the record and decides. Does not write anything and does not call the
 * planner — the door claims and re-runs only once it knows which of the four
 * routes this is.
 *
 * `now` and `windowMinutes` are injectable so a test can prove the window in
 * both directions without waiting one out; production passes neither.
 */
export async function decideWhatsAppRoute(input: {
  text: string;
  businessId: string;
  now?: number;
  windowMinutes?: number;
  db?: Queryable;
}): Promise<WhatsAppRoute> {
  const nowMs = input.now ?? Date.now();
  const windowMinutes = input.windowMinutes ?? config.whatsappQuestionWindowMinutes;

  const open = await pendingQuestions({
    businessId: input.businessId,
    channel: 'whatsapp',
    ...(input.db !== undefined ? { db: input.db } : {}),
  });

  // Closure is read BEFORE the window is applied, and that is deliberate: a
  // question that aged out is still open (the owner's rule — it stays open
  // until one side says otherwise), so "סגרנו" has to be able to reach it.
  // The window governs what counts as an ANSWER; it does not govern what the
  // owner is allowed to close.
  if (isClosureCommand(input.text)) return { kind: 'closure', open };

  const answerable = open.filter((record) => withinQuestionWindow(record, nowMs, windowMinutes));
  if (answerable.length > 1) return { kind: 'ambiguous', open: answerable };

  const only = answerable[0];
  if (only !== undefined) return { kind: 'answer', instruction: only };

  return { kind: 'new', staleOpen: open.length };
}

/**
 * Takes this answer, or reports that somebody else already did.
 *
 * `claimAnswer` is a single `UPDATE ... WHERE answer IS NULL`, so a dashboard
 * answer racing a WhatsApp message on the same parked question cannot both
 * re-run the planner and both supersede the job. It is the only writer of
 * that column — see its own docblock, including why the overwriting
 * `recordAnswer` it replaced is gone.
 */
export async function claimAsAnswer(
  instruction: InstructionRecord,
  answer: string,
  options: { businessId: string; db?: Queryable },
): Promise<boolean> {
  return claimAnswer(instruction.instructionId, answer, {
    businessId: options.businessId,
    ...(options.db !== undefined ? { db: options.db } : {}),
  });
}

/**
 * Takes a parked instruction off the open list for good, and makes sure
 * nothing later speaks for it.
 *
 * **The claim comes BEFORE the transition, and that order is the point.** A
 * parked job sits in `understand`, which `reportCandidates`
 * (`whatsapp-report.ts`) does not look at; the moment it moves to a terminal
 * phase it becomes a report candidate, and `classifyJob` would read a
 * superseded job — terminal phase, no bound plan, no step rows — as
 * `{ outcome: 'failed' }` and tell the owner over WhatsApp that his
 * instruction failed. It did not fail: he answered it, or he closed it.
 * Claiming the opening message `'reported'` first means that by the time the
 * phase is reportable the claim is already in place. The reverse order leaves
 * a window in which the report pass can send that false sentence; this order
 * leaves a window in which the job stays parked in `understand`, which no
 * reader acts on at all.
 *
 * A claim that comes back `false` is not an error and is not retried:
 * something else already made it, which is the ordinary outcome of losing a
 * race (`claimForReport`'s own docblock). A job with no opening message —
 * structurally impossible for a job this door opened, since the door links
 * before it settles — simply has no claim to make.
 *
 * `actor: 'human'`, because both callers are the owner acting: answering, or
 * saying it is finished. Neither is the orchestrator deciding on its own.
 */
export async function retireOpenInstruction(
  instruction: InstructionRecord,
  options: { to: 'closed' | 'failed'; reason: string; businessId: string },
): Promise<void> {
  const messageId = await whatsAppMessageOf(instruction.jobId, {
    businessId: options.businessId,
  });
  if (messageId !== null) {
    await claimForReport(messageId, 'terminal', { businessId: options.businessId });
  }
  await transition(instruction.jobId, {
    to: options.to,
    actor: 'human',
    reason: options.reason,
    businessId: options.businessId,
  });
}

/** Audit reasons. English, like every other `job_steps.reason` in this project. */
export function reasonForSupersededByWhatsAppAnswer(replacementJobId: string): string {
  return `whatsapp door: answered; superseded by ${replacementJobId}`;
}
export const REASON_CLOSED_BY_OWNER = 'whatsapp door: closed by the owner';
export const REASON_ANSWER_REFUSED =
  'whatsapp door: answer could not be planned; closed rather than left parked';

// --- What the owner reads. Hebrew, every one of them. -----------------------

/**
 * How much of a previous request is quoted back. Long enough to recognise,
 * short enough not to bury the sentence that follows it.
 *
 * `stripBidiControls` because this text is not always the owner's own
 * keystrokes: an instruction that arrived as a voice note is a transcription
 * provider's output, and a directionality override in it would make the
 * quoted request read as a different request from the one actually being
 * joined or closed — the same reason the signing card strips them from a
 * document's `original_name`. Nothing is HTML-escaped here: this is a plain
 * WhatsApp message, and an entity would render as the literal `&lt;`.
 */
const SNIPPET_CHARS = 60;

export function instructionSnippet(text: string): string {
  const clean = stripBidiControls(text).trim().replace(/\s+/g, ' ');
  return clean.length <= SNIPPET_CHARS ? clean : `${clean.slice(0, SNIPPET_CHARS)}…`;
}

/** Spec §5.4: the acknowledgement always says which reading was chosen. */
export const ROUTED_AS_NEW = 'קראתי את זה כהוראה חדשה.';

export function routedAsAnswer(instruction: InstructionRecord): string {
  return `הוספתי את זה לבקשה הקודמת ("${instructionSnippet(instruction.text)}").`;
}

/**
 * Said when a message routes as a new instruction while older questions are
 * still open past the window — so they do not quietly stop existing on the
 * one surface the owner reads.
 */
export function staleOpenNotice(count: number): string {
  const what =
    count === 1 ? 'שאלה אחת פתוחה מלפני כן' : `${count} שאלות פתוחות מלפני כן`;
  return `דרך אגב, יש ${what} שעדיין מחכות לך — אפשר לענות עליהן במסך "מה לעשות" בדשבורד, או לכתוב לי "${SUGGESTED_CLOSURE_VERB}" כדי לסגור אותן.`;
}

/** The refusal to guess. Names both exits — see the module docblock. */
export function ambiguousQuestion(open: readonly InstructionRecord[]): string {
  const list = open.map((record) => `· "${instructionSnippet(record.text)}"`).join('\n');
  return [
    'יש לי כרגע יותר משאלה פתוחה אחת, ואני לא מנחשת לאיזו מהן ההודעה הזו היא התשובה:',
    list,
    `אפשר לענות על כל אחת בנפרד במסך "מה לעשות" בדשבורד, או לכתוב לי "${SUGGESTED_CLOSURE_VERB}" כדי לסגור את כולן.`,
  ].join('\n');
}

export function closureConfirmation(closed: readonly InstructionRecord[]): string {
  const list = closed.map((record) => `· "${instructionSnippet(record.text)}"`).join('\n');
  return ['סגרתי. מה שנסגר:', list].join('\n');
}

export const NOTHING_OPEN_TO_CLOSE =
  'אין לי כרגע בקשה פתוחה לסגור — הכול כבר סגור מהצד שלי.';

/**
 * Said when the re-run on the joined text asked ANOTHER question: the message
 * may not have been an answer at all. Bound 3 in the module docblock.
 */
export const STILL_NEEDS_ANSWER_HINT =
  'אם ההודעה הזו לא הייתה תשובה לשאלה שלי — אפשר לכתוב אותה מחדש כהוראה נפרדת, ואז אקרא אותה כהוראה חדשה.';

/**
 * Said when the re-run refused outright. The previous request is CLOSED here
 * rather than left open, and that is the one place this module chooses to
 * close something the owner did not name — for a reason worth stating: were
 * it left open, the very next message would be joined to it and refused
 * again, and the one after that, with nothing the owner could type to get
 * out. Closing a parked `understand` job cancels nothing and undoes nothing
 * — it has no plan, it spent nothing, and it never reached a step — so the
 * cost of closing it is that he retypes a request, against a loop with no
 * exit.
 */
export const CLOSED_AFTER_REFUSAL =
  'סגרתי את הבקשה הקודמת כדי שלא נסתובב במקום. אפשר לכתוב אותה מחדש.';
