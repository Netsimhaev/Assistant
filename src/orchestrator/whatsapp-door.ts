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
 * message is ever recorded.
 *
 * **A message is claimed before it costs anything irreversible, never
 * before.** `claimMessage` runs immediately before the one call that can
 * open a job and spend a planner call — never earlier. A crash between the
 * two loses one instruction rather than risking a second one being planned
 * for the same inbound message on a retry; the same direction
 * `markContentIngested` (`src/documents/read.ts`) already chose for the same
 * reason. A throw anywhere after that point settles the message `'failed'`
 * and does not stop the rest of the batch — one poison message must not
 * block the queue, the same isolation `runDueJobs` gives each job it runs.
 *
 * **This module never decides anyone's trust level for anything it hands
 * onward.** The one instruction pipeline it drives (`runInstruction`,
 * `./instruct.js`) already fixes that on its own, as a literal, and takes no
 * parameter that could override it — a caller able to aim that value would be
 * a caller able to forge an instruction. This module has no business logic of
 * its own that needs to state it either, and does not; see
 * `whatsapp-invariants.test.ts`.
 *
 * **The transcript rides the acknowledgement — one outbound message, never
 * two.** A mistranscription is a mistaken instruction (spec §6.3), and the
 * gap between what the owner said and what the assistant heard must be
 * visible in the same breath as what the assistant is about to do about it,
 * not in a message the owner might never connect to the one that follows it.
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
 * order, not whichever order this pass happened to see them.
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
  /** From the authorised sender, but no job resulted — a cap, a transcription problem, or `runInstruction` itself declining. */
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
 * the tie-break — see the module docblock.
 */
function compareInbound(a: NormalizedInboundMessage, b: NormalizedInboundMessage): number {
  const byTime = new Date(a.providerTimestamp).getTime() - new Date(b.providerTimestamp).getTime();
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

async function processOne(msg: NormalizedInboundMessage, ctx: ProcessContext): Promise<ProcessOutcome> {
  const senderKind: SenderKind = isPrincipalSender(ctx.charter, msg.senderNumber)
    ? 'principal'
    : 'other';

  const stored = await recordInbound(
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
    // or spend anything, and no reply, ever.
    await settleMessage(stored.id, 'handled', {}, { businessId: ctx.businessId });
    return 'recordedOnly';
  }

  let claimed = false;
  try {
    let text: string;
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

    // The one line that matters for crash safety — see the module docblock.
    // Nothing above this spends anything irreversible; everything below it
    // can.
    claimed = await claimMessage(stored.id, { businessId: ctx.businessId });
    if (!claimed) return 'skipped'; // raced by another runner on this message.

    const usedToday = await whatsappInstructionsToday({ businessId: ctx.businessId });
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

    const outcome = await runInstruction(
      { text },
      {
        businessId: ctx.businessId,
        ...(ctx.planner !== undefined ? { planner: ctx.planner } : {}),
      },
    );

    // Every attempt this door makes, whatever came of it — see
    // `recordWhatsAppInstructionAttempt`'s own docblock on why a refusal
    // still has to spend a slot.
    await recordWhatsAppInstructionAttempt({ status: outcome.status, textLength: text.length });

    const ack = composeAck(outcome);
    const fullText = withTranscriptEcho(isAudio, text, ack);
    const jobId = outcome.status === 'refused' ? null : outcome.jobId;

    if (jobId !== null) {
      // Written first, then the settle that follows carries the same id —
      // two commits, not one transaction. A crash between them loses the
      // link, never a second job: the message is already claimed, and
      // nothing re-offers a claimed message for planning again.
      await linkWhatsAppMessage(jobId, stored.id, { businessId: ctx.businessId });
    }

    await ctx.messenger.send({ text: fullText, jobId });

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
    // `runDueJobs` gives each job. Only settled `'failed'` when it was
    // claimed: an error before that point spent nothing irreversible, and
    // the row is simply left `'received'` rather than marked as a failure it
    // never truly reached.
    if (claimed) {
      await settleMessage(stored.id, 'failed', {}, { businessId: ctx.businessId }).catch(() => {
        // Best-effort: the message is already unrecoverable from this pass's
        // point of view, and a second failure here must not take the rest of
        // the batch down with it.
      });
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
  // docblock. Left to throw on a stale schema rather than caught here: a
  // door that cannot parse its own policy has nothing to check a sender
  // against, and recording a message under a guessed trust level is worse
  // than not running at all.
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
    const outcome = await processOne(msg, ctx);
    if (outcome === 'recordedOnly') result.recordedOnly += 1;
    else if (outcome === 'instructed') result.instructed += 1;
    else if (outcome === 'refused') result.refused += 1;
    // 'skipped' — a redelivery, a race on the claim, or a failure before the
    // message was ever claimed — adds to none of the three buckets.
  }

  return result;
}
