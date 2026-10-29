/**
 * The door: turns an inbound WhatsApp message from the owner into a real
 * instruction, and leaves everyone else's message recorded and untouched.
 *
 * **Everyone else is invisible to this door, by design (Decision 4).** A
 * message from anyone who is not the one authority number the charter names
 * is stored for the conversation screen and settled — nothing is answered,
 * nothing is planned, and nothing is sent back. The customer feels no change,
 * and that is the point: this is not a support bot, it is the owner's own
 * channel, and a reply composed for a stranger would be this assistant acting
 * on behalf of someone who never asked it to.
 *
 * **The sender's trust is read off the signed charter, once, before the
 * queue is touched at all — never guessed per message.** The active charter
 * is the only thing that can say who the owner is on this channel
 * (`isPrincipalSender`, `src/governance/principal-number.ts`), and a stale
 * charter nobody can parse is a door running with no policy to check a
 * sender against — worse than not running. Loading it throws on a stale
 * schema (`loadActiveCharter`'s own docblock) and that throw is left to
 * propagate out of this module rather than caught here, before a single
 * message is ever recorded. **A missing charter is fatal for a sharper
 * reason than staleness, fix round 1's review caught this:** with no charter
 * there is no principal number at all, so `principalWhatsAppKey` returns
 * `null` and `isPrincipalSender` returns `false` for *everyone*, including
 * the owner — the door would record the owner's own messages as a
 * stranger's, settle them `'handled'`, and reply to no one, permanently and
 * without a trace. Throwing before the first message is recorded is the only
 * safe response to that, not merely a policy preference.
 *
 * **A message is claimed before it costs anything that can open a job, never
 * before.** `claimMessage` runs immediately before the daily instruction cap
 * check and `runInstruction` — never earlier. A crash between the two loses
 * one instruction rather than risking a second one being planned for the
 * same inbound message on a retry; the same direction `markContentIngested`
 * (`src/documents/read.ts`) already chose for the same reason. This is
 * narrower than "nothing above the claim spends anything" — fix round 1's
 * Minor 9 caught an earlier version of this docblock overstating it:
 * transcription runs above the claim, on purpose (the brief's own ordering),
 * calls a paid provider, and writes its own daily-budget audit row; what the
 * claim actually guards is the one thing that can *open a job*.
 *
 * **Every throw inside a message's own processing is caught, settles the row,
 * and — once the sender is positively known to be the principal — tells the
 * owner, rather than leaving silence in every direction.** Fix round 1's
 * Important 2–4: the whole per-message body sits inside one `try`, not just
 * the tail end after the claim, because `pollOnce` has already drained the
 * message out of the provider's queue by the time this runs — a throw from
 * `recordInbound`, from the transcription call (which awaits
 * `downloadAudio()` before any claim exists), or from anything after the
 * claim must not abandon the rest of an already-collected batch, the same
 * isolation `runDueJobs` gives each job it runs. The notify-on-failure is
 * gated **positively**, not merely wrapped in a flag that defaults safe: a
 * throw before the sender is established as the principal (a `recordInbound`
 * failure, or the stranger branch's own `settleMessage` failing) stays
 * silent on purpose — Decision 4 says a customer feels no change, and
 * "we crashed, so we replied to a customer" is the one exception that rule
 * cannot survive.
 *
 * **This module never decides anyone's trust level for anything it hands
 * onward.** The one instruction pipeline it drives (`runInstruction`,
 * `./instruct.js`) already fixes that on its own, as a literal, and takes no
 * parameter that could override it — a caller able to aim that value would be
 * a caller able to forge an instruction. `whatsapp-invariants.test.ts` pins
 * this positively: the only thing that crosses into `runInstruction` as its
 * first argument is `{ text }`.
 *
 * **What this module DOES decide, and the one rule that keeps it safe:
 * whether those bytes were typed.** `runInstruction`'s `textOrigin` is
 * required and has no default, and this door is the only caller that can
 * ever hand it `'transcribed'`. The value is derived from `mediaKind` — how
 * the message arrived — and from the stored origin of the instruction an
 * answer is joined to, and from **nothing inside the text**. That is the
 * whole point: a voice note's text is a third-party transcription model's
 * output, and `authorisedRecipients`'s verbatim arm grants a standing
 * authorisation on the strength of "the owner typed this address himself".
 * A mistranscription, or a compromised provider, naming a recipient must not
 * be able to buy that. Authority is never derivable from content, and a
 * transcript is content. `whatsapp-invariants.test.ts` pins the derivation
 * expression itself, because this is the one place in the file where a quiet
 * edit — reading the flag off `heard`, say — would hand a provider the
 * owner's own authority.
 *
 * **The transcript rides the acknowledgement — one outbound message, never
 * two.** A mistranscription is a mistaken instruction (spec §6.3), and the
 * gap between what the owner said and what the assistant heard must be
 * visible in the same breath as what the assistant is about to do about it,
 * not in a message the owner might never connect to the one that follows it.
 *
 * **The acknowledgment is sent before the job is linked to the message, not
 * after.** Fix round 1's Important 5: ruling 2 requires `linkWhatsAppMessage`
 * before `settleMessage`, and that ordering is kept, but a link write sitting
 * between the ack and the settle meant a link failure threw *before* the
 * owner ever heard anything — for a job that `runDueJobs` would really go on
 * to execute. The order is `runInstruction` → the budget audit row → the ack
 * → the link → the settle: a crash between the ack and the link leaves an
 * unlinked job the owner already knows exists (a dashboard lookup gap), which
 * is recoverable; a crash before the ack leaves the owner in the dark about
 * an instruction that is about to run, which is not.
 *
 * **Messages are collected, then sorted, then processed — never handled
 * inline from inside the gateway's own delivery callback.** `pollOnce` drives
 * the registered handler in whatever order the transport delivered the
 * batch, and acting the moment a message arrives there would process a burst
 * in delivery order, possibly overlapping, rather than the order the owner
 * actually sent them in. Sorted by the provider's own timestamp, oldest
 * first, with the provider's own message id as the deterministic tie-break —
 * the same shape `unclaimedInbound` and `conversation`
 * (`src/whatsapp/store.ts`) already use for the same reason: two instructions
 * arriving in the same second must still come out in one reconstructible
 * order, not whichever order this pass happened to see them. A
 * `providerTimestamp` that fails to parse (`NaN`) never wins a comparison —
 * fix round 1's Minor 10 — the tie-break is what decides instead, because a
 * value this door could not read is never a permissive "sort wherever".
 *
 * **`gateway.pollOnce()` is raced against a deadline, not awaited directly —
 * fix round A, finding 3.** This is the first thing `runWhatsAppDoor` does
 * on every pass, inside `schedulerPass`'s one sequential await chain
 * alongside `expireOverdue` and every due plan. `WhatsAppGateway.pollOnce`
 * takes no `AbortSignal` — same reason as every other external call this
 * project races this way (the gateway's own `health` check in
 * `scheduler.ts`, `msg.downloadAudio()` and the provider call in
 * `transcribe.ts`): a signal is advisory, and nothing forces a provider
 * implementation, or a test double, to check it. A wedged provider here
 * does not delay one message; it freezes the entire pass — approval fuses
 * stop burning, no due plan runs, nothing closes — for as long as the
 * provider hangs.
 */
import { config } from '../config.js';
import type { InstructionRecord } from '../governance/instructions.js';
import { loadActiveCharter } from '../charter/store.js';
import type { BusinessCharter } from '../domain/charter.js';
import { authorityNumberKey, isPrincipalSender } from '../governance/principal-number.js';
import { stripBidiControls } from '../util/bidi.js';
import type { InstructionTextOrigin } from '../governance/typed-recipients.js';
import type { NormalizedInboundMessage, WhatsAppGateway } from '../whatsapp/gateway.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import {
  claimMessage,
  recordInbound,
  recordWhatsAppInstructionAttempt,
  settleMessage,
  whatsappInstructionsToday,
  type SenderKind,
  type StoredMessage,
} from '../whatsapp/store.js';
import { transcribeInbound, type TranscriptionProvider } from '../whatsapp/transcribe.js';
import { runInstruction, type InstructionOutcome, type RunInstructionOptions } from './instruct.js';
import { linkWhatsAppMessage } from './jobs.js';
import { handleMailCardMessage, isMailCardAction, openMailCards } from './whatsapp-mail-card.js';
import {
  applyConfirmation,
  openConfirmations,
  readConfirmation,
  WHATSAPP_MESSAGE_MAX_CHARS,
  WHATSAPP_QUESTION_TOO_LONG,
  type ConfirmOutcome,
  type ConfirmReading,
} from './command-confirm.js';
import { markConfirmationDelivered } from '../governance/instruction-confirmations.js';
import {
  ambiguousQuestion,
  answerableWhatsAppQuestions,
  claimAsAnswer,
  closureConfirmation,
  decideWhatsAppRoute,
  reasonForSupersededByWhatsAppAnswer,
  retireOpenInstruction,
  routedAsAnswer,
  staleOpenNotice,
  CLOSED_AFTER_REFUSAL,
  NOTHING_OPEN_TO_CLOSE,
  REASON_ANSWER_REFUSED,
  REASON_CLOSED_BY_OWNER,
  ROUTED_AS_NEW,
  STILL_NEEDS_ANSWER_HINT,
  type WhatsAppRoute,
} from './whatsapp-routing.js';

export interface DoorResult {
  /** However many messages `pollOnce` delivered to this pass, redeliveries included. */
  polled: number;
  /** Reached `runInstruction` and came back `'planned'`, `'needs_answer'` or `'needs_confirmation'` — a job exists. */
  instructed: number;
  /** From anyone but the one authorised sender. Stored, answered to no one. */
  recordedOnly: number;
  /** From the authorised sender, but no job resulted — a cap, a transcription problem, a thrown error, or `runInstruction` itself declining. */
  refused: number;
  /**
   * The owner closed open work with a closure word (task 12) — no job, no
   * planner call, nothing refused.
   *
   * Counted apart from `refused` for the reason `malformedSenderCount`'s own
   * docblock gives: `refused` means "the authorised sender asked for
   * something and got nothing", and a closure got exactly what it asked for.
   * Folding a success into the refusal count is how a real refusal rate
   * stops being readable — the same conflation fix round B had to undo for
   * malformed sender numbers. A message whose closure word found nothing
   * open still counts here, not under `refused`: "there is nothing open" is
   * an honest, complete answer to what was asked, not a denial of it.
   */
  closed: number;
  /**
   * The owner answered an open mailbox reply card (`whatsapp-mail-card.ts`):
   * approved it with "שלח", or replaced its body. Counted apart from
   * `instructed` because no instruction ran and no job was opened — a
   * decision on an existing card is not a new request. A refusal there (a
   * voice note, two open cards) counts under `refused`, and a closure word
   * under `closed`, exactly as on the instruction path.
   */
  mailCardReplies: number;
  /**
   * The owner answered an open boss-command confirmation question
   * (`command-confirm.ts`) with a confirm, a pick or a cancel, and the
   * answer was applied — or found already decided. Counted apart from
   * `instructed` for the reason `mailCardReplies` gives: no instruction ran
   * and no job was opened. A collision refusal, an unclear pick or a thrown
   * apply counts under `refused`.
   */
  confirmationReplies: number;
  /**
   * A confirmation answer `applyConfirmation` threw on — decided or not, not
   * applied (a bound-hash mismatch, a transient transition error). The owner
   * was told to retry on the dashboard, and `settleDecidedConfirmations`
   * moves the job on next pass; this is the operator's trace of it, printed
   * by `logErrored` (`scheduler-log.ts`).
   */
  confirmErrored: Array<{ jobId: string; error: string }>;
  /**
   * Counted separately from `recordedOnly` — fix round B, finding 3. A
   * `senderNumber` that fails `authorityNumberKey` outright is a GATEWAY
   * CONTRACT VIOLATION (`NormalizedInboundMessage.senderNumber`'s own
   * docblock states the required form), not evidence that a stranger
   * messaged the business. Before this field existed, both cases produced
   * the identical `'recordedOnly'` outcome, which is exactly how the
   * round-A finding — a gateway handing `senderNumber` up in the wrong
   * format — would have gone unnoticed in production: the owner's own
   * messages filed as a stranger's, silently, with nothing to distinguish
   * it from genuine customer traffic. This count is nonzero only when the
   * NUMBER ITSELF could not be parsed; it says nothing about whether the
   * sender is the principal, and a well-formed stranger's number still
   * counts only toward `recordedOnly`, unchanged.
   */
  malformedSenderCount: number;
}

/** Shown to the owner's own recording, quoted back verbatim, ahead of whatever happened next. */
const TRANSCRIPT_PREFIX = 'שמעתי: ';

/**
 * How long `runWhatsAppDoor` waits for `gateway.pollOnce()` before giving up
 * — fix round A, finding 3. Matches `ADAPTER_TIMEOUT_MS`
 * (`src/orchestrator/run-plan.ts`) and `TRANSCRIBE_TIMEOUT_MS`
 * (`src/whatsapp/transcribe.ts`) rather than the 5s "courtesy
 * acknowledgement" class: draining a provider's notification queue is real
 * external work, not a quick up-or-down probe, and a batch of messages can
 * legitimately take a few seconds against a healthy provider.
 */
const POLL_TIMEOUT_MS = 60_000;

/**
 * Bound a promise `gateway.pollOnce()` might never settle.
 *
 * A local copy of the pattern this project already carries at `notify.ts`,
 * `messenger.ts`, `run-plan.ts`, `oauth-token.ts`, `runtime.ts`'s
 * `withAlertDeadline`, `scheduler.ts`'s `withHealthCheckDeadline`, and
 * `transcribe.ts`'s own `withDeadline`: an `AbortSignal` is advisory only,
 * and nothing forces a gateway implementation — or a test double — to
 * check it, so racing the call itself against an independent timer is what
 * actually binds the wait.
 */
function withPollDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`gateway.pollOnce() did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

const NO_TRANSCRIBER =
  'אין לי כרגע אפשרות לתמלל הקלטות. אפשר לכתוב את ההודעה בטקסט?';
const TRANSCRIPTION_CAPPED =
  'הגעתי היום למכסת התמלולים. אפשר לכתוב את ההודעה בטקסט?';
const EMPTY_MESSAGE =
  'לא קיבלתי טקסט או הקלטה שאפשר להבין מתוך ההודעה. אפשר לכתוב מה צריך?';
const INSTRUCTION_CAP_REACHED =
  'הגעתי היום למכסת ההוראות המותרת. אפשר לנסות שוב מחר.';
/** No ready-made sentence exists on a `'planned'` outcome — see `composeAck` below. */
const PLANNED_ACK = 'קיבלתי, אני מטפלת בזה.';
/**
 * Told to the owner, and only the owner (see the module docblock's positive
 * notify gate), when something throws after the sender is already known to
 * be the principal. Deliberately generic — the real cause belongs in logs
 * and the audit trail, never guessed at out loud to a human who cannot act
 * on a stack trace.
 */
const SOMETHING_WENT_WRONG =
  'קרתה תקלה אצלי בטיפול בהודעה הזו. אפשר לנסות לשלוח אותה שוב?';

function tooLongMessage(seconds: number): string {
  return `ההקלטה ארוכה מדי (${seconds} שניות). אפשר לכתוב את ההודעה בטקסט?`;
}

/** `transcribeInbound`'s `'too_large'` outcome — see its own docblock on why this is a separate check from duration. */
const RECORDING_TOO_LARGE =
  'ההקלטה גדולה מדי. אפשר לכתוב את ההודעה בטקסט?';

/**
 * The sentence the owner reads, built from whatever `runInstruction` already
 * phrased — never a paraphrase of it. `'refused'` and `'needs_answer'` each
 * carry exactly one Hebrew sentence of their own (the reason, the question),
 * so this returns it unchanged. `'planned'` carries no such sentence — only
 * structured facts about what was granted — so this is the one branch where
 * this module composes its own, folding in the two notes `instruct.ts`
 * already attaches when they are set.
 */
function composeAck(outcome: InstructionOutcome): string {
  if (outcome.status === 'refused') return outcome.reason;
  if (outcome.status === 'needs_answer') return outcome.question;
  // Boss command (spec §4): the confirmation question IS the ack — the owner
  // answers it in this chat (`handleConfirmationMessage`). It is sent only
  // after `runInstruction` returned, so the `instruction_confirmations` row
  // already exists, and the row is stamped `delivered_at` only after the send
  // came back `ok` — the stamp the strict-after check reads, so no reply can
  // be dated before the question it answers was delivered.
  if (outcome.status === 'needs_confirmation') {
    return outcome.identityNote === null
      ? outcome.question
      : [outcome.question, outcome.identityNote].join('\n\n');
  }
  const parts = [PLANNED_ACK];
  if (outcome.grantNote !== null) parts.push(outcome.grantNote);
  // The owner's ruling of 05/10/2026, second half: an address that came only
  // from a recording needs his explicit word, and he has to be TOLD that.
  // This is the one channel that can produce the note at all — a recording
  // only ever arrives here — so dropping it here is the whole difference
  // between "asks him to confirm" and a silent refusal to use the address he
  // just spoke.
  if (outcome.recordingNote !== null) parts.push(outcome.recordingNote);
  if (outcome.identityNote !== null) parts.push(outcome.identityNote);
  return parts.join('\n\n');
}

/**
 * **The echo is bidi-stripped, and this is the place on the whole path where
 * that matters most.** `transcript` is model output from a third-party
 * provider over somebody's audio, and `identityNote` (composed into `rest`)
 * can carry a contact name that reached memory from a document someone else
 * wrote. A right-to-left override inside either rearranges what the owner
 * READS while leaving the bytes that will be ACTED ON untouched — so the echo
 * he checks before anything runs can show a different instruction from the one
 * about to be planned. That is exactly the hazard `escLabel` was written for
 * on the dashboard (`dashboard/views.ts`), and it is the same hazard here:
 * WhatsApp renders these marks too.
 *
 * `stripBidiControls`, never a second copy of the character class — the single
 * owner is `util/bidi.ts`, extracted in Task 12 precisely so two call sites
 * cannot drift apart on which codepoints count.
 */
function withTranscriptEcho(isAudio: boolean, transcript: string, rest: string): string {
  if (!isAudio) return stripBidiControls(rest);
  return `${TRANSCRIPT_PREFIX}"${stripBidiControls(transcript)}"\n\n${stripBidiControls(rest)}`;
}

/**
 * Oldest first by the provider's own clock, the provider's own message id as
 * the tie-break — see the module docblock. Every message with an unreadable
 * `providerTimestamp` (one that does not parse, so `getTime()` yields `NaN`)
 * sorts strictly **after** every message with a readable one, and ties among
 * unreadable timestamps are broken by id exactly like ties among readable
 * ones — a value this door could not read is never ranked ahead of one it
 * could, and never merely "wherever".
 *
 * **Fix round 2 replaced an earlier version that returned `0` for any pair
 * involving a `NaN`, and that was not a genuine total order — the fourth
 * instance in this project of a comment claiming a property the code did not
 * have.** Treating a `NaN` pair as "equal under time" does not give the
 * unreadable message one consistent place in the order: it ties with *every*
 * message it is compared against, readable or not, so it interleaves by id
 * with the whole batch rather than sorting consistently last. That breaks
 * transitivity — a worked counter-example: `a = (NaN, id "b")`,
 * `b = (t 100, id "a")`, `c = (t 1, id "c")` gives `compare(c, b) < 0`,
 * `compare(b, a) < 0`, and `compare(a, c) < 0`, a cycle no total order can
 * produce. `Array.prototype.sort` has no obligation to behave predictably
 * under a comparator that is not a total order, so the one property this
 * function exists to guarantee — a burst processed in one reconstructible
 * order — was exactly what an inconsistent comparator could silently defeat.
 * `whatsapp-door.test.ts` pins the exact resulting order for a batch that
 * mixes unreadable and readable timestamps directly against this function
 * (see its own export docblock), and fails under the `return 0` form this
 * replaced.
 *
 * Exported for `whatsapp-door.test.ts` alone, to unit-test the comparator's
 * ordering directly — including an unreadable-timestamp case that cannot be
 * driven through `runWhatsAppDoor` at all, because `providerTimestamp` also
 * has to survive `recordInbound`'s `TIMESTAMPTZ` column, and a string this
 * comparator treats as unreadable (`NaN` from `getTime()`) is typically one
 * Postgres rejects outright rather than storing. No other production code
 * calls this directly; `runWhatsAppDoor`'s own `[...collected].sort(...)` is
 * still the only real caller.
 */
export function compareInbound(a: NormalizedInboundMessage, b: NormalizedInboundMessage): number {
  const aTime = new Date(a.providerTimestamp).getTime();
  const bTime = new Date(b.providerTimestamp).getTime();
  const aUnreadable = Number.isNaN(aTime);
  const bUnreadable = Number.isNaN(bTime);
  if (aUnreadable && bUnreadable) return a.providerMessageId.localeCompare(b.providerMessageId);
  if (aUnreadable) return 1; // unreadable sorts after readable — never "wherever".
  if (bUnreadable) return -1;
  const byTime = aTime - bTime;
  if (byTime !== 0) return byTime;
  return a.providerMessageId.localeCompare(b.providerMessageId);
}

interface ProcessContext {
  businessId: string;
  charter: BusinessCharter;
  messenger: BossMessenger;
  provider?: TranscriptionProvider;
  planner?: RunInstructionOptions['planner'];
  /**
   * Called once per message whose `senderNumber` fails `authorityNumberKey`
   * — fix round B, finding 3. A callback into `runWhatsAppDoor`'s own
   * `result.malformedSenderCount`, not a new field on `ProcessOutcome`:
   * `ProcessOutcome` names which BUCKET a message landed in, and this is
   * orthogonal to every bucket (a malformed number still settles exactly
   * as a stranger's message would) — widening the enum's shape for one
   * side-channel signal would touch every `return` in this function.
   */
  reportMalformedSender: () => void;
  /** Called when `applyConfirmation` throws — into `DoorResult.confirmErrored`. */
  reportConfirmError: (jobId: string, error: string) => void;
  /**
   * Overrides `config.whatsappQuestionWindowMinutes` for one call. Production
   * leaves it unset — the same escape hatch `pollTimeoutMs` and
   * `transcribeInbound`'s `timeoutMs` already give their own bounds, and for
   * the same reason: a test must be able to prove both sides of a window
   * without waiting one out.
   */
  questionWindowMinutes?: number;
}

type ProcessOutcome =
  | 'recordedOnly'
  | 'instructed'
  | 'refused'
  | 'closed'
  | 'mailCard'
  | 'confirmation'
  | 'skipped';

/** Spec §10.11, verbatim: more than one thing is open, and the answer cannot say which. */
export const SEVERAL_OPEN_REFUSAL = 'יש כמה שאלות פתוחות — עני בדשבורד';
/** The answer to a confirmation, applied: the job runs; its result is the report pass's to tell. */
export const CONFIRM_EXECUTING = 'מבצעת.';
export const CONFIRM_CANCELLED = 'בוטל.';
export const CONFIRM_ALREADY_DECIDED = 'כבר טופל.';
export const CONFIRM_UNCLEAR = 'לא הבנתי למי התכוונת — השיבי במספר האפשרות או בשם המלא.';
/** `applyConfirmation` threw after the answer was read — the settle sweep takes the job from here. */
export const CONFIRM_FAILED = 'לא הצלחתי לבצע — נסי שוב בדשבורד.';

const CONFIRM_REPLY: Record<ConfirmOutcome, string> = {
  executing: CONFIRM_EXECUTING,
  cancelled: CONFIRM_CANCELLED,
  already_decided: CONFIRM_ALREADY_DECIDED,
  unclear: CONFIRM_UNCLEAR,
};

/**
 * Tells the owner something and closes the message out — no job involved, no
 * instruction resulted. Settled `'failed'`, the same state a thrown error
 * after the claim settles to: nothing was accomplished for this message, only
 * for a reason that is known and already told to the owner rather than an
 * unexpected crash. `'handled'` is reserved for a branch that actually
 * finished what it set out to do — recording a stranger's message, or
 * standing up a job — not merely for "nothing crashed".
 */
async function tellOwnerAndSettle(
  ctx: ProcessContext,
  messageId: string,
  text: string,
): Promise<void> {
  await ctx.messenger.send({ text, jobId: null });
  await settleMessage(messageId, 'failed', {}, { businessId: ctx.businessId });
}

/**
 * The owner's TYPED message while at least one boss-command confirmation is
 * open on WhatsApp (spec §4.3, §10.11). Runs FIRST for a principal's typed
 * message — before the mail card and before routing.
 *
 * Returns `'passthrough'`, claiming and settling nothing, when the message is
 * not an answer to the question at all (`readConfirmation` → `none`): a new
 * instruction, an answer to something else, or "שלח" for a mail card — and
 * the confirmation stays pending. Otherwise the message is claimed FIRST, so
 * a redelivered or raced copy of the same "כן" cannot decide twice, and:
 *
 *   - **the collision rule**: an answer with more than one thing open across
 *     confirmations, mail cards and clarifying questions inside their windows
 *     (or more than one confirmation) is refused with `SEVERAL_OPEN_REFUSAL`,
 *     and nothing changes. "כן" does not say which;
 *   - `unclear` → `CONFIRM_UNCLEAR`; the question stays open;
 *   - `confirm`/`cancel` → `applyConfirmation`, and the reply for its
 *     outcome. A throw is caught, told as `CONFIRM_FAILED` and reported to
 *     the operator; the settle sweep moves the job on.
 *
 * With several confirmations open the message is read against each, and it
 * is an answer if any of them reads it as one — so the collision is refused
 * rather than passed through as a new instruction.
 */
async function handleConfirmationMessage(input: {
  msg: NormalizedInboundMessage;
  storedId: string;
  ctx: ProcessContext;
}): Promise<'confirmation' | 'refused' | 'skipped' | 'passthrough'> {
  const { msg, storedId, ctx } = input;
  // Typed only: a transcript or a caption is not the owner's keystrokes.
  if (msg.mediaKind !== null) return 'passthrough';
  if (msg.body === null) return 'passthrough';
  const text = msg.body;
  const windowOverride =
    ctx.questionWindowMinutes !== undefined ? { windowMinutes: ctx.questionWindowMinutes } : {};

  const confirmations = await openConfirmations({
    businessId: ctx.businessId,
    channel: 'whatsapp',
    inboundAt: new Date(msg.providerTimestamp),
    ...windowOverride,
  });
  if (confirmations.length === 0) return 'passthrough';

  const readings: ConfirmReading[] = confirmations.map((c) => readConfirmation(text, c.options));
  if (readings.every((r) => r.kind === 'none')) return 'passthrough';

  const claimed = await claimMessage(storedId, { businessId: ctx.businessId });
  if (!claimed) return 'skipped';

  const reply = async (
    replyText: string,
    state: 'handled' | 'failed',
    jobId: string | null,
  ): Promise<void> => {
    // Linked to the job when one is known, so the outbound row says which
    // held command it answered.
    await ctx.messenger.send({ text: replyText, jobId });
    await settleMessage(storedId, state, jobId !== null ? { jobId } : {}, {
      businessId: ctx.businessId,
    });
  };

  const cards = await openMailCards({
    businessId: ctx.businessId,
    excludeMessageId: storedId,
    inboundAt: msg.providerTimestamp,
    ...windowOverride,
  });
  const questions = await answerableWhatsAppQuestions({
    businessId: ctx.businessId,
    ...windowOverride,
  });
  const only = confirmations.length === 1 ? confirmations[0] : undefined;
  const reading = readings[0];
  if (only === undefined || reading === undefined || cards.length + questions.length > 0) {
    await reply(SEVERAL_OPEN_REFUSAL, 'failed', null);
    return 'refused';
  }

  if (reading.kind !== 'confirm' && reading.kind !== 'cancel') {
    await reply(CONFIRM_UNCLEAR, 'failed', null);
    return 'refused';
  }

  const by = `whatsapp:${authorityNumberKey(msg.senderNumber) ?? msg.senderNumber}`;
  let outcome: ConfirmOutcome;
  try {
    outcome = await applyConfirmation(only.jobId, reading, by, {
      businessId: ctx.businessId,
      whatsappInboundAt: new Date(msg.providerTimestamp),
    });
  } catch (error) {
    ctx.reportConfirmError(only.jobId, error instanceof Error ? error.message : String(error));
    await reply(CONFIRM_FAILED, 'failed', only.jobId);
    return 'refused';
  }
  const applied = outcome !== 'unclear';
  await reply(CONFIRM_REPLY[outcome], applied ? 'handled' : 'failed', only.jobId);
  return applied ? 'confirmation' : 'refused';
}

/**
 * One message, start to finish. Never throws — every exit is a `return`,
 * including from the `catch` — so a poison message cannot abort the batch
 * `runWhatsAppDoor` collected it into; see the module docblock on isolation.
 *
 * `stored`, `established`, `attemptedInstruction` and `instructionRecorded`
 * are declared outside the `try` on purpose: the `catch` needs to know how
 * far processing got — is there a row to settle, is this positively the
 * principal (so telling them something is safe), had an instruction attempt
 * already begun (so the daily budget must still count it), was that attempt
 * already recorded (so the `catch` does not double-count the one
 * `runInstruction` call this message ever makes) — and a variable assigned
 * only inside the `try` would not survive into the `catch` that needs to
 * read it.
 */
async function processOne(msg: NormalizedInboundMessage, ctx: ProcessContext): Promise<ProcessOutcome> {
  let stored: StoredMessage | null = null;
  // Set only once this message is positively known to be the principal's own
  // — never on a guess, never by default. Gates the owner-facing notify in
  // the `catch` below; see the module docblock's "positive notify gate".
  let established = false;
  // Set only once a `runInstruction` call has actually begun — a throw past
  // this point may already have been billed (a planner call), so the daily
  // budget must still count it (fix round 1, Important 7).
  let attemptedInstruction = false;
  // Set only once the normal-flow write below actually ran. Without this,
  // a throw AFTER that write (the link, the final settle) would make the
  // `catch` write a second `whatsapp_instruction` row for the same single
  // attempt — a different bug in the opposite direction from the one this
  // fix round closes.
  let instructionRecorded = false;
  // What the owner actually said: the message body, or the transcript of his
  // recording. This is what gets echoed back to him and stored on the
  // message row — never the joined text below.
  let heard = '';
  // What `runInstruction` receives. The same thing as `heard` for a new
  // instruction, and `previous instruction + heard` when this message is the
  // answer to an open question (task 12). Kept as a separate variable rather
  // than computed at the call site, so the one call below still passes
  // `{ text }` and nothing else: `whatsapp-invariants.test.ts` pins that
  // argument's exact shape, and an answer must not be able to smuggle a
  // second field in beside it any more than a sender identifier could.
  // (The literal call spelling is deliberately not written in this comment —
  // that same invariant counts call sites by matching the name followed by an
  // open paren, and a mention in prose would read as a second one.)
  let text = '';

  try {
    const senderKind: SenderKind = isPrincipalSender(ctx.charter, msg.senderNumber)
      ? 'principal'
      : 'other';

    stored = await recordInbound(
      {
        providerMessageId: msg.providerMessageId,
        senderNumber: msg.senderNumber,
        senderKind,
        body: msg.body,
        mediaKind: msg.mediaKind,
        providerTimestamp: msg.providerTimestamp,
      },
      { businessId: ctx.businessId },
    );
    // A redelivery of a message already recorded — the unique index decided,
    // not a prior read (`recordInbound`'s own docblock). Nothing to settle:
    // whatever happened on the first delivery already closed it out, or is
    // still in flight on the pass that is handling it.
    if (stored === null) return 'skipped';

    // Fix round B, finding 3 — positive check, reported AFTER the dedup
    // guard above so a redelivered duplicate of the same malformed message
    // is not counted twice. `isPrincipalSender` already fails closed on a
    // number `authorityNumberKey` cannot parse (it returns `false`, the
    // exact same outcome a genuine stranger produces), so this changes
    // NOTHING about how the message is handled below — it only tells the
    // two cases apart for whoever reads `DoorResult.malformedSenderCount`.
    // `senderKind === 'other'` for a genuine stranger's well-formed number
    // does not trip this at all.
    if (authorityNumberKey(msg.senderNumber) === null) {
      ctx.reportMalformedSender();
    }

    if (senderKind === 'other') {
      // Decision 4. Recorded for the conversation screen and closed out
      // immediately — no claim, because nothing on this branch will ever plan
      // or spend anything, and no reply, ever. `established` stays `false`:
      // even if the settle below throws, a stranger gets no message from
      // this assistant, full stop.
      await settleMessage(stored.id, 'handled', {}, { businessId: ctx.businessId });
      return 'recordedOnly';
    }

    established = true;

    const isAudio = msg.mediaKind === 'audio';

    // A boss-command confirmation question is read FIRST of all (spec
    // §10.11) — before the mail card, transcription and routing — and only
    // for TYPED text: a voice note or a caption that looks like "כן" never
    // confirms; it goes on through the door below as a new instruction, and
    // the question stays pending (§4.3). The typed-only check is the first
    // line of `handleConfirmationMessage`, the one place it lives. A message
    // that is not an answer ("שלח" included) falls through untouched.
    const confirmAnswer = await handleConfirmationMessage({ msg, storedId: stored.id, ctx });
    if (confirmAnswer !== 'passthrough') return confirmAnswer;

    // An open mailbox reply card is read next — before transcription, the
    // instruction cap and `pendingQuestions` — but only for TYPED text that
    // is one of the three mail-card actions ("שלח", a closure word,
    // "נוסח: …"), only inside the card's window, and only for a message sent
    // after the card was presented (`openMailCards`). Anything else — a voice
    // note, a caption, a new instruction — falls through to the ordinary door
    // below, and the card stays open.
    if (msg.mediaKind === null && msg.body !== null && isMailCardAction(msg.body)) {
      const cards = await openMailCards({
        businessId: ctx.businessId,
        excludeMessageId: stored.id,
        inboundAt: msg.providerTimestamp,
        ...(ctx.questionWindowMinutes !== undefined
          ? { windowMinutes: ctx.questionWindowMinutes }
          : {}),
      });
      if (cards.length > 0) {
        const handled = await handleMailCardMessage({
          msg,
          storedId: stored.id,
          cards,
          messenger: ctx.messenger,
          businessId: ctx.businessId,
        });
        if (handled === 'decided' || handled === 'replaced') return 'mailCard';
        if (handled !== 'passthrough') return handled;
      }
    }

    if (isAudio) {
      if (ctx.provider === undefined) {
        await tellOwnerAndSettle(ctx, stored.id, NO_TRANSCRIBER);
        return 'refused';
      }
      const transcribed = await transcribeInbound(msg, senderKind, {
        businessId: ctx.businessId,
        provider: ctx.provider,
      });
      if (transcribed.status === 'too_long') {
        await tellOwnerAndSettle(ctx, stored.id, tooLongMessage(transcribed.seconds));
        return 'refused';
      }
      if (transcribed.status === 'too_large') {
        await tellOwnerAndSettle(ctx, stored.id, RECORDING_TOO_LARGE);
        return 'refused';
      }
      if (transcribed.status === 'capped') {
        await tellOwnerAndSettle(ctx, stored.id, TRANSCRIPTION_CAPPED);
        return 'refused';
      }
      if (transcribed.status === 'failed') {
        await tellOwnerAndSettle(ctx, stored.id, transcribed.reason);
        return 'refused';
      }
      heard = transcribed.text;
    } else {
      if (msg.body === null || msg.body.trim() === '') {
        await tellOwnerAndSettle(ctx, stored.id, EMPTY_MESSAGE);
        return 'refused';
      }
      heard = msg.body;
    }

    // The line that matters for crash safety — see the module docblock.
    // Nothing above this can open a job; everything below it can.
    const claimed = await claimMessage(stored.id, { businessId: ctx.businessId });
    if (!claimed) return 'skipped'; // raced by another runner on this message.

    // What this message IS — answer, closure, or new instruction (task 12).
    // Read from the record, never stored a second time; see
    // `whatsapp-routing.ts`'s own docblock for the derivation and for the
    // stated cost of the owner's chosen rule.
    //
    // Read BEFORE the daily instruction cap below, and that order is
    // load-bearing in one direction only: a CLOSURE must still work on a day
    // the cap is spent, because it spends nothing (no planner call, no job)
    // and refusing it would leave the owner's open work with no way to close
    // it until tomorrow — the one thing the owner's rule forbids. An ANSWER
    // is still subject to the cap: it does re-run the planner, and the
    // refusal leaves the question open (nothing is claimed below), so his
    // answer works tomorrow.
    const route: WhatsAppRoute = await decideWhatsAppRoute({
      text: heard,
      businessId: ctx.businessId,
      ...(ctx.questionWindowMinutes !== undefined
        ? { windowMinutes: ctx.questionWindowMinutes }
        : {}),
    });

    if (route.kind === 'closure') {
      // Settled 'handled', not 'failed': unlike `tellOwnerAndSettle`'s
      // branches, this one finished exactly what it set out to do. Nothing
      // links a job to this message, so no report is ever owed for it.
      // `NOTHING_OPEN_TO_CLOSE` settles the same way for the same reason —
      // "there is nothing open" is a complete answer, not a denial.
      //
      // Closed BEFORE the owner is told, the same departure from Important 5
      // the refusal path below makes and for the same reason: the sentence
      // names what was closed, and a message claiming a close that has not
      // happened yet is worse than a message that never arrived. There is no
      // running job here for Important 5 to protect.
      for (const open of route.open) {
        await retireOpenInstruction(open, {
          to: 'closed',
          reason: REASON_CLOSED_BY_OWNER,
          businessId: ctx.businessId,
        });
      }
      const confirmation =
        route.open.length === 0 ? NOTHING_OPEN_TO_CLOSE : closureConfirmation(route.open);
      await ctx.messenger.send({
        text: withTranscriptEcho(isAudio, heard, confirmation),
        jobId: null,
      });
      await settleMessage(
        stored.id,
        'handled',
        isAudio ? { transcript: heard } : {},
        { businessId: ctx.businessId },
      );
      return 'closed';
    }

    if (route.kind === 'ambiguous') {
      // The refusal to guess. No claim, no planner call, nothing closed —
      // every open question stays exactly where it was, and the sentence the
      // owner reads names both ways out.
      await ctx.messenger.send({
        text: withTranscriptEcho(isAudio, heard, ambiguousQuestion(route.open)),
        jobId: null,
      });
      await settleMessage(
        stored.id,
        'failed',
        isAudio ? { transcript: heard } : {},
        { businessId: ctx.businessId },
      );
      return 'refused';
    }

    const usedToday = await whatsappInstructionsToday(ctx.businessId);
    if (usedToday >= config.whatsappInstructionsPerDay) {
      await ctx.messenger.send({
        text: withTranscriptEcho(isAudio, heard, INSTRUCTION_CAP_REACHED),
        jobId: null,
      });
      await settleMessage(
        stored.id,
        'failed',
        isAudio ? { transcript: heard } : {},
        { businessId: ctx.businessId },
      );
      return 'refused';
    }

    // One winner, decided in SQL (`claimAnswer`). A lost claim means a
    // dashboard answer reached the same question first, so the question is no
    // longer open and this message really is a new instruction — the route
    // narrows from 'answer' to 'new' here rather than failing, and the
    // acknowledgement below says so, because what the owner is told has to
    // match what actually happened.
    let answered: InstructionRecord | null = null;
    if (route.kind === 'answer') {
      const won = await claimAsAnswer(route.instruction, heard, { businessId: ctx.businessId });
      if (won) answered = route.instruction;
    }

    text = answered !== null ? `${answered.text}\n\n${heard}` : heard;

    // Where those bytes came from, derived from HOW the message arrived and
    // never from what it says — see the module docblock, and
    // `whatsapp-invariants.test.ts`, which pins this expression.
    //
    // Both conditions are positive and both are necessary. `!isAudio`: a
    // voice note's text is a transcription provider's model output, which
    // nobody typed. `answered === null || answered.textOrigin === 'typed'`:
    // an answer is planned over the JOIN of the parked instruction and this
    // message (`text`, above), so a typed answer to a question raised by a
    // voice note must not launder the recorded half — the join is the owner's
    // own bytes only if BOTH halves are. Reading the stored origin is what
    // makes that answerable at all, and it is read from the instruction row
    // (`InstructionRecord.textOrigin`, written once at insert), never guessed
    // from the message this pass is holding.
    //
    // The cost, stated: one origin covers the whole joined text, so a typed
    // answer that names an address is treated as recorded when the half it
    // joins was recorded. That withholds a grant the owner's rule would have
    // allowed — over-tight, never over-permissive — and he is told exactly
    // that, with the recipient named (`renderRecordingNote`, `instruct.ts`).
    const textOrigin: InstructionTextOrigin =
      !isAudio && (answered === null || answered.textOrigin === 'typed') ? 'typed' : 'transcribed';

    // Spec §5.4: the acknowledgement always says which reading was chosen, so
    // a wrong reading is visible before anything goes out.
    const routeNotice =
      answered !== null
        ? routedAsAnswer(answered)
        : [
            ROUTED_AS_NEW,
            // Only on the 'new' route — 'answer' carries no stale count, and
            // a lost claim leaves nothing honest to say about what else is
            // open, since the winner may be closing it as this runs.
            ...(route.kind === 'new' && route.staleOpen > 0
              ? [staleOpenNotice(route.staleOpen)]
              : []),
          ].join('\n\n');

    attemptedInstruction = true;
    const outcome = await runInstruction(
      { text },
      {
        businessId: ctx.businessId,
        // Required, no default — see this module's docblock and the option's
        // own. Computed above, from the media kind and the joined half's
        // stored origin.
        textOrigin,
        // The door this message came through: a confirmation question is
        // answered where it was asked (boss command, spec §4).
        channel: 'whatsapp',
        // Spec §7.2, and the same value the dashboard's answer route passes:
        // this is the second pass over the same chain, so the identity
        // question is suppressed even if a name is still ambiguous. The
        // deliberate coarseness of the flag (`instruct.ts`) is what bounds
        // the loop — it does not remember WHICH name was ambiguous, only that
        // a second pass is underway.
        ...(answered !== null ? { identityAsked: true } : {}),
        ...(ctx.planner !== undefined ? { planner: ctx.planner } : {}),
      },
    );

    // Every attempt this door makes, whatever came of it — see
    // `recordWhatsAppInstructionAttempt`'s own docblock on why a refusal
    // still has to spend a slot. `businessId` is positional and required on
    // both of these calls (fix round 1, Critical 1): the read above and this
    // write must agree on which business's ledger they touch, or the cap
    // this pair exists to enforce means nothing for any business this door
    // is explicitly given.
    await recordWhatsAppInstructionAttempt(ctx.businessId, {
      status: outcome.status,
      textLength: text.length,
    });
    // Marks the row as already written, so a throw further down this same
    // function (the link write, the final settle, the ack) does NOT make the
    // `catch` write a second row for the one attempt `runInstruction` just
    // made — see the `catch` block's own comment on why it checks this flag.
    instructionRecorded = true;

    const ack = composeAck(outcome);
    const jobId = outcome.status === 'refused' ? null : outcome.jobId;

    // An answer whose re-run REFUSED closes the previous request before the
    // owner is told, rather than after — the one place this function departs
    // from fix round 1's Important 5 ("ack before any further write"), and
    // only where that rule has nothing to protect: a refusal produced no
    // replacement job, so there is no running job the owner could be left
    // silent about. What the rule would cost here is worse than what it
    // buys: `CLOSED_AFTER_REFUSAL` tells him the previous request is closed,
    // and a message that claims something which has not happened yet is the
    // one thing this project refuses to send (see `trip()`'s own
    // `KillSwitchAuditUnrecordedError` reasoning). Why it is closed at all
    // rather than left open: see that constant's docblock — left open, the
    // next message joins it and refuses again, with no exit the owner can
    // type.
    const extra: string[] = [];
    if (answered !== null && outcome.status === 'refused') {
      await retireOpenInstruction(answered, {
        to: 'closed',
        reason: REASON_ANSWER_REFUSED,
        businessId: ctx.businessId,
      });
      extra.push(CLOSED_AFTER_REFUSAL);
    }
    // A second question on the joined text is the signal that the message was
    // probably not an answer at all. Said plainly, with what to do about it.
    if (answered !== null && outcome.status === 'needs_answer') {
      extra.push(STILL_NEEDS_ANSWER_HINT);
    }

    let fullText = withTranscriptEcho(
      isAudio,
      heard,
      [routeNotice, ack, ...extra].join('\n\n'),
    );
    // A confirmation question counts as presented on WhatsApp only once it
    // was delivered (`markConfirmationDelivered`, below). Too long for one
    // message, it is never truncated: a pointer to the dashboard goes out
    // instead, and the row stays undelivered — answerable there, never here.
    let questionSent = outcome.status === 'needs_confirmation';
    if (questionSent && fullText.length > WHATSAPP_MESSAGE_MAX_CHARS) {
      questionSent = false;
      fullText = withTranscriptEcho(
        isAudio,
        heard,
        [routeNotice, WHATSAPP_QUESTION_TOO_LONG, ...extra].join('\n\n'),
      );
    }

    // Ack BEFORE the link write — fix round 1, Important 5. A link failure
    // below must not leave the owner silent about a job that will really
    // run; ruling 2's own requirement (link before settle) is unaffected,
    // since the link still lands before the settle three lines down.
    const sent = await ctx.messenger.send({ text: fullText, jobId });
    // Only an `ok` send stamps the question: a failed send left the owner
    // with nothing to answer, and a later "כן" must not confirm it.
    if (questionSent && sent.ok && jobId !== null) {
      await markConfirmationDelivered(jobId, { businessId: ctx.businessId });
    }

    // The answered question's own job is retired only now, for the
    // `planned`/`needs_answer` outcomes: a replacement job exists and is
    // about to run, so Important 5 applies in full — the owner hears about
    // it before anything else is written. `retireOpenInstruction` also marks
    // the old opening message `'reported'`, which is what stops the report
    // pass telling him his answered instruction "failed"; see that
    // function's own docblock.
    if (answered !== null && outcome.status !== 'refused') {
      await retireOpenInstruction(answered, {
        to: 'failed',
        reason: reasonForSupersededByWhatsAppAnswer(outcome.jobId),
        businessId: ctx.businessId,
      });
    }

    if (jobId !== null) {
      // A crash here loses the link, never a second job: the message is
      // already claimed, and nothing re-offers a claimed message for
      // planning again.
      await linkWhatsAppMessage(jobId, stored.id, { businessId: ctx.businessId });
    }

    // 'handled' for a job that now exists (`planned`/`needs_answer`),
    // 'failed' for a plain `'refused'` — the instruction did not succeed,
    // even when `runInstruction` itself declined cleanly rather than
    // throwing. The transcript is worth keeping either way: the owner really
    // did say it, whatever came of it.
    await settleMessage(
      stored.id,
      jobId !== null ? 'handled' : 'failed',
      {
        ...(isAudio ? { transcript: heard } : {}),
        ...(jobId !== null ? { jobId } : {}),
      },
      { businessId: ctx.businessId },
    );

    return jobId !== null ? 'instructed' : 'refused';
  } catch {
    // One poison message must not block the queue — the same isolation
    // `runDueJobs` gives each job. Three things, each gated on how far
    // processing actually got before it threw (fix round 1, Important 2–4,
    // 7):
    //
    //   1. If an instruction attempt had begun AND was not already recorded
    //      by the normal flow, the daily budget still counts it — a planner
    //      call may already have been billed, and losing the row would let
    //      that spend go uncounted. `instructionRecorded` guards the other
    //      direction: a throw AFTER the normal-flow write (the link, the
    //      final settle) must not count the same attempt twice.
    //   2. If a row exists for this message, it is settled `'failed'` —
    //      whether the throw landed before or after the claim. Nothing in
    //      production reads `unclaimedInbound` today, so leaving a row
    //      `'received'` forever is not "will be retried", it is "lost, with
    //      no trace" — worse than an honest `'failed'`.
    //   3. The owner is told, in Hebrew, but **only** once this message was
    //      positively established as the principal's own. A throw before
    //      that point (a `recordInbound` failure, or the stranger branch's
    //      own settle failing) stays silent — Decision 4 again: a stranger
    //      gets no reply, ever, not even an apology for a crash.
    if (attemptedInstruction && !instructionRecorded) {
      await recordWhatsAppInstructionAttempt(ctx.businessId, {
        status: 'refused',
        textLength: text.length,
      });
    }
    if (stored !== null) {
      await settleMessage(stored.id, 'failed', {}, { businessId: ctx.businessId }).catch(() => {
        // Best-effort: the message is already unrecoverable from this pass's
        // point of view, and a second failure here must not take the rest of
        // the batch down with it.
      });
    }
    if (established) {
      // `messenger.send` never throws by contract (`BossMessenger`'s own
      // docblock) — nothing further to guard here.
      await ctx.messenger.send({ text: SOMETHING_WENT_WRONG, jobId: null });
      return 'refused';
    }
    return 'skipped';
  }
}

export async function runWhatsAppDoor(options: {
  gateway: WhatsAppGateway;
  messenger: BossMessenger;
  businessId?: string;
  provider?: TranscriptionProvider;
  /** Test seam only; production leaves it unset and `runInstruction` uses the real planner. */
  planner?: RunInstructionOptions['planner'];
  /**
   * The charter the CALLER already loaded, so this door checks the sender
   * against the exact same read `scheduler.ts` used to derive the
   * principal's number for the messenger it is handing in alongside this —
   * fix round 1, F11. Without this, the door's own `loadActiveCharter` below
   * ran a SECOND, independently-timed load every pass; an amendment signed
   * between the two left a pass whose door authorised the NEW principal
   * number while the messenger (built from the FIRST load) replied to the
   * OLD one. Optional, and this module still loads its own copy when
   * omitted — Task 7's property that this door never runs without a charter
   * holds for every caller, not only the one that happens to have one
   * already in hand.
   */
  charter?: BusinessCharter;
  /**
   * Overrides `POLL_TIMEOUT_MS` for one call. Production never passes this;
   * it exists so a test can prove the race without waiting out a real 60s
   * timer — the same escape hatch `transcribeInbound`'s `timeoutMs` and
   * `downloadTimeoutMs` already give their own deadlines, same reason.
   */
  pollTimeoutMs?: number;
  /**
   * Overrides `config.whatsappQuestionWindowMinutes` for one call — see
   * `ProcessContext.questionWindowMinutes`. Test seam only; production
   * leaves it unset.
   */
  questionWindowMinutes?: number;
}): Promise<DoorResult> {
  const businessId = options.businessId ?? config.businessId;
  const { gateway, messenger } = options;

  // Loaded once, before the queue is touched at all — see the module
  // docblock. Left to throw on a stale schema rather than caught here, and
  // treated the same way when no charter is installed at all: either way,
  // this door has no principal number to check a sender against.
  //
  // Skipped entirely when the caller already supplies one (`options.charter`
  // — see that field's own docblock, F11): the caller's read is what this
  // door checks the sender against, not a second one of its own.
  let charter: BusinessCharter;
  if (options.charter !== undefined) {
    charter = options.charter;
  } else {
    const active = await loadActiveCharter(businessId);
    if (active === null) {
      throw new Error(
        `runWhatsAppDoor: no active charter for business ${businessId} — refusing to guess who the owner is`,
      );
    }
    charter = active.charter;
  }

  const collected: NormalizedInboundMessage[] = [];
  gateway.onInbound(async (msg) => {
    // Collected, never handled here — see the module docblock on why this
    // callback does no work of its own.
    collected.push(msg);
  });

  const polled = await withPollDeadline(gateway.pollOnce(), options.pollTimeoutMs ?? POLL_TIMEOUT_MS);
  const ordered = [...collected].sort(compareInbound);

  const result: DoorResult = {
    polled,
    instructed: 0,
    recordedOnly: 0,
    refused: 0,
    closed: 0,
    mailCardReplies: 0,
    confirmationReplies: 0,
    confirmErrored: [],
    malformedSenderCount: 0,
  };

  const ctx: ProcessContext = {
    businessId,
    charter,
    messenger,
    // Mutates `result` directly rather than a second accumulator — see
    // `ProcessContext.reportMalformedSender`'s own docblock on why this is
    // a callback rather than a field on `ProcessOutcome`.
    reportMalformedSender: () => {
      result.malformedSenderCount += 1;
    },
    reportConfirmError: (jobId, error) => {
      result.confirmErrored.push({ jobId, error });
    },
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.planner !== undefined ? { planner: options.planner } : {}),
    ...(options.questionWindowMinutes !== undefined
      ? { questionWindowMinutes: options.questionWindowMinutes }
      : {}),
  };

  for (const msg of ordered) {
    // `processOne` never throws — see its own docblock — so this `try` is a
    // last-resort safety net, not the primary mechanism. Belt and braces:
    // the same isolation `runDueJobs` gives each job it runs is given here
    // twice, once inside `processOne` (which actually settles and notifies)
    // and once here (which merely ensures a genuinely unexpected throw
    // cannot take the rest of the batch down with it).
    let outcome: ProcessOutcome;
    try {
      outcome = await processOne(msg, ctx);
    } catch {
      continue;
    }
    if (outcome === 'recordedOnly') result.recordedOnly += 1;
    else if (outcome === 'instructed') result.instructed += 1;
    else if (outcome === 'refused') result.refused += 1;
    else if (outcome === 'closed') result.closed += 1;
    else if (outcome === 'mailCard') result.mailCardReplies += 1;
    else if (outcome === 'confirmation') result.confirmationReplies += 1;
    // 'skipped' — a redelivery, a race on the claim, or a failure before the
    // message was ever claimed — adds to none of the four buckets.
  }

  return result;
}
