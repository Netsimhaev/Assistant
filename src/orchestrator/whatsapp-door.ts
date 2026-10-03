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
 * this positively: the only thing that crosses into `runInstruction` is
 * `{ text }`.
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
 */
import { config } from '../config.js';
import { loadActiveCharter } from '../charter/store.js';
import type { BusinessCharter } from '../domain/charter.js';
import { isPrincipalSender } from '../governance/principal-number.js';
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

export interface DoorResult {
  /** However many messages `pollOnce` delivered to this pass, redeliveries included. */
  polled: number;
  /** Reached `runInstruction` and came back `'planned'` or `'needs_answer'` — a job exists. */
  instructed: number;
  /** From anyone but the one authorised sender. Stored, answered to no one. */
  recordedOnly: number;
  /** From the authorised sender, but no job resulted — a cap, a transcription problem, a thrown error, or `runInstruction` itself declining. */
  refused: number;
}

/** Shown to the owner's own recording, quoted back verbatim, ahead of whatever happened next. */
const TRANSCRIPT_PREFIX = 'שמעתי: ';

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
  const parts = [PLANNED_ACK];
  if (outcome.grantNote !== null) parts.push(outcome.grantNote);
  if (outcome.identityNote !== null) parts.push(outcome.identityNote);
  return parts.join('\n\n');
}

function withTranscriptEcho(isAudio: boolean, transcript: string, rest: string): string {
  return isAudio ? `${TRANSCRIPT_PREFIX}"${transcript}"\n\n${rest}` : rest;
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
 */
/**
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
}

type ProcessOutcome = 'recordedOnly' | 'instructed' | 'refused' | 'skipped';

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
      if (transcribed.status === 'capped') {
        await tellOwnerAndSettle(ctx, stored.id, TRANSCRIPTION_CAPPED);
        return 'refused';
      }
      if (transcribed.status === 'failed') {
        await tellOwnerAndSettle(ctx, stored.id, transcribed.reason);
        return 'refused';
      }
      text = transcribed.text;
    } else {
      if (msg.body === null || msg.body.trim() === '') {
        await tellOwnerAndSettle(ctx, stored.id, EMPTY_MESSAGE);
        return 'refused';
      }
      text = msg.body;
    }

    // The line that matters for crash safety — see the module docblock.
    // Nothing above this can open a job; everything below it can.
    const claimed = await claimMessage(stored.id, { businessId: ctx.businessId });
    if (!claimed) return 'skipped'; // raced by another runner on this message.

    const usedToday = await whatsappInstructionsToday(ctx.businessId);
    if (usedToday >= config.whatsappInstructionsPerDay) {
      await ctx.messenger.send({
        text: withTranscriptEcho(isAudio, text, INSTRUCTION_CAP_REACHED),
        jobId: null,
      });
      await settleMessage(
        stored.id,
        'failed',
        isAudio ? { transcript: text } : {},
        { businessId: ctx.businessId },
      );
      return 'refused';
    }

    attemptedInstruction = true;
    const outcome = await runInstruction(
      { text },
      {
        businessId: ctx.businessId,
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
    const fullText = withTranscriptEcho(isAudio, text, ack);
    const jobId = outcome.status === 'refused' ? null : outcome.jobId;

    // Ack BEFORE the link write — fix round 1, Important 5. A link failure
    // below must not leave the owner silent about a job that will really
    // run; ruling 2's own requirement (link before settle) is unaffected,
    // since the link still lands before the settle three lines down.
    await ctx.messenger.send({ text: fullText, jobId });

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
        ...(isAudio ? { transcript: text } : {}),
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
  now?: Date;
}): Promise<DoorResult> {
  const businessId = options.businessId ?? config.businessId;
  const { gateway, messenger } = options;

  // Loaded once, before the queue is touched at all — see the module
  // docblock. Left to throw on a stale schema rather than caught here, and
  // treated the same way when no charter is installed at all: either way,
  // this door has no principal number to check a sender against.
  const active = await loadActiveCharter(businessId);
  if (active === null) {
    throw new Error(
      `runWhatsAppDoor: no active charter for business ${businessId} — refusing to guess who the owner is`,
    );
  }
  const charter = active.charter;

  const collected: NormalizedInboundMessage[] = [];
  gateway.onInbound(async (msg) => {
    // Collected, never handled here — see the module docblock on why this
    // callback does no work of its own.
    collected.push(msg);
  });

  const polled = await gateway.pollOnce();
  const ordered = [...collected].sort(compareInbound);

  const result: DoorResult = { polled, instructed: 0, recordedOnly: 0, refused: 0 };

  const ctx: ProcessContext = {
    businessId,
    charter,
    messenger,
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.planner !== undefined ? { planner: options.planner } : {}),
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
    // 'skipped' — a redelivery, a race on the claim, or a failure before the
    // message was ever claimed — adds to none of the three buckets.
  }

  return result;
}
