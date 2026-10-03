/**
 * Turns a voice note into text — or says plainly why it did not.
 *
 * Two sides, one trust rule (spec §6.1). The principal's recording inherits
 * `boss`; anyone else's inherits `unknown_external` and can never become an
 * instruction — the transcript carries the sender's trust level the same way
 * every other piece of ingested content in this project does, because a
 * transcript that quietly became the business's own knowledge would be an
 * injection that just took a day.
 *
 * TWO BUDGETS, AND THIS IS WHY (spec §6.2). A shared cap lets a flood of
 * customer voice notes exhaust the budget and then the OWNER'S OWN recording
 * goes untranscribed — a stranger degrading the owner's channel. The
 * principal's budget (`whatsappTranscribeBossPerDay`) and everyone else's
 * (`whatsappTranscribeOtherPerDay`) are therefore counted, and capped,
 * separately — never merged into one number.
 *
 * Both budgets are counted from `audit_log` rows, not a maintained counter —
 * the project's standing rule (see `curationRunsToday`, `src/memory/
 * curate.ts`): a counter kept beside the source can drift from it with
 * nobody noticing. There is no dedicated "which budget" column on
 * `audit_log`; `provenance` already carries exactly that distinction
 * (`boss` vs `unknown_external`), so the count query reads it instead of
 * adding a second field that could say something different.
 *
 * NEVER GUESSES. A provider that throws, returns nothing, or returns
 * whitespace produces `{ status: 'failed' }` — never a string this module
 * invented or a partial reading. On a channel that can spend money or make a
 * commitment, the gap between "I heard X" and "I am guessing X" must be
 * visible before anything happens (spec §6.3): the same rule that says a
 * value this system failed to read is never a permissive value.
 *
 * The audit row is written on the failure path too, success or not, because
 * a provider that charged and then failed still charged — the same
 * reasoning `recordCurationFailure` (`src/memory/curate.ts`) is built on.
 */
import type { Queryable } from '../db/pool.js';
import { getPool } from '../db/pool.js';
import { config } from '../config.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import type { TrustLevel } from '../domain/trust.js';
import type { NormalizedInboundMessage } from './gateway.js';
import type { SenderKind } from './store.js';

export type TranscribeOutcome =
  | { status: 'transcribed'; text: string }
  | { status: 'too_long'; seconds: number }
  | { status: 'capped' }
  | { status: 'failed'; reason: string };

export type TranscriptionProvider = (input: {
  bytes: Buffer;
  mimeType: string;
}) => Promise<{ text: string }>;

/** Shown to a human when transcription produced nothing usable. Never a guess. */
const CANNOT_UNDERSTAND = 'לא הצלחתי להבין את ההקלטה, תוכל לכתוב?';

const SENDER_LABEL: Record<SenderKind, string> = {
  principal: 'הבעלים',
  other: 'אחר',
};

/**
 * The trust level a transcript from this sender kind inherits — spec §6.1.
 * Doubles as the cap's discriminator: `provenance` is a column every audit
 * row already carries, so the two daily budgets are told apart by reading
 * it rather than by adding a second column that names the sender kind and
 * could say something different from this one.
 */
function provenanceOf(senderKind: SenderKind): TrustLevel {
  return senderKind === 'principal' ? 'boss' : 'unknown_external';
}

/**
 * How many transcription attempts this sender kind has made today —
 * successful or failed, because a failed attempt still called the provider.
 * Counts `audit_log` rows; see this module's own docblock for why.
 */
export async function whatsappTranscriptionsToday(
  senderKind: SenderKind,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<number> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log
      WHERE business_id = $1 AND kind = 'whatsapp' AND provenance = $2
        AND at >= date_trunc('day', now())`,
    [businessId, provenanceOf(senderKind)],
  );
  return Number(rows[0]?.n ?? '0');
}

export async function transcribeInbound(
  msg: NormalizedInboundMessage,
  senderKind: SenderKind,
  options: { businessId: string; provider: TranscriptionProvider; maxSeconds?: number },
): Promise<TranscribeOutcome> {
  const { businessId, provider } = options;

  if (msg.downloadAudio === undefined) {
    // A caller contract violation, not a property of the message — this
    // function is only ever handed an audio message. Surfacing loudly here
    // matches `settleMessage`'s own rule: an unresolved precondition is a
    // bug, not a result to absorb into a permissive outcome.
    throw new Error(
      'transcribeInbound: message has no downloadAudio (mediaKind !== "audio")',
    );
  }

  // ORDER MATTERS: length cap, then daily cap, then the provider call, then
  // the audit row. The length check runs first because it costs nothing and
  // needs no budget lookup; the daily cap runs before the provider call
  // because that call is the one that spends money.
  const { bytes, mimeType, seconds } = await msg.downloadAudio();

  const maxSeconds = options.maxSeconds ?? config.whatsappMaxAudioSeconds;
  if (seconds > maxSeconds) {
    return { status: 'too_long', seconds };
  }

  const perDay =
    senderKind === 'principal'
      ? config.whatsappTranscribeBossPerDay
      : config.whatsappTranscribeOtherPerDay;
  const usedToday = await whatsappTranscriptionsToday(senderKind, { businessId });
  if (usedToday >= perDay) {
    return { status: 'capped' };
  }

  try {
    const result = await provider({ bytes, mimeType });
    const text = result.text.trim();
    if (text === '') {
      await recordAttempt(businessId, senderKind, { succeeded: false, seconds, textLength: 0 });
      return { status: 'failed', reason: CANNOT_UNDERSTAND };
    }
    await recordAttempt(businessId, senderKind, { succeeded: true, seconds, textLength: text.length });
    return { status: 'transcribed', text };
  } catch {
    // The error itself is never recorded or surfaced — see the module
    // docblock on never guessing and `src/domain/audit.ts`'s `whatsapp`
    // entry on never carrying anything but counts and the sender kind. An
    // upstream error message is neither.
    await recordAttempt(businessId, senderKind, { succeeded: false, seconds, textLength: 0 });
    return { status: 'failed', reason: CANNOT_UNDERSTAND };
  }
}

/**
 * The one audit row a transcription attempt produces, success or failure
 * alike. Carries counts (duration, character count) and the sender kind —
 * via `provenance`, not the message body, not the transcript. See
 * `src/domain/audit.ts`'s `whatsapp` entry for the full reasoning.
 */
async function recordAttempt(
  businessId: string,
  senderKind: SenderKind,
  counts: { succeeded: boolean; seconds: number; textLength: number },
): Promise<void> {
  await appendAudit(
    {
      actor: 'orchestrator',
      kind: 'whatsapp',
      charterVersion: 'n/a',
      provenance: provenanceOf(senderKind),
      inputHash: canonicalHash(counts),
      artifacts: [],
      costMinor: null,
      tokens: null,
      reason: counts.succeeded
        ? `תמלול הודעת וואטסאפ · ${SENDER_LABEL[senderKind]} · הצליח · ${counts.seconds} שניות · ${counts.textLength} תווים`
        : `תמלול הודעת וואטסאפ · ${SENDER_LABEL[senderKind]} · נכשל · ${counts.seconds} שניות`,
    },
    { businessId },
  );
}
