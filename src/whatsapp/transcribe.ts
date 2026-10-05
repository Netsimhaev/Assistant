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
 * The count query also filters on `kind = 'whatsapp_transcription'`, not a
 * generic `'whatsapp'` — fix round 1's Important 2. A bucket named after the
 * *channel* rather than the *event* invites every future WhatsApp feature
 * that writes an audit row (an instruction count, per `whatsappInstructionsPerDay`
 * in `src/config.ts`, is already planned) to land in the same count this
 * module reads as "a transcription happened". `provenance` alone cannot
 * rescue that: an owner dictating instructions by typed text would still
 * carry `provenance: 'boss'`, so a generic kind would have silently spent
 * his transcription budget on something that never touched the transcription
 * provider at all. Naming the kind after the specific event — matching
 * `curation`, `delegation`, `credential_change` and every other entry in
 * `AuditKind`, none of which name a channel — closes that off structurally:
 * a future `whatsapp_instruction` kind (or whatever that task calls it) is a
 * different string, and this query simply never sees it.
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
 *
 * The provider call is raced against a deadline, not awaited directly — fix
 * round 1's Important 1. `TranscriptionProvider` takes no `AbortSignal`, same
 * as `WhatsAppGateway.sendMessage` and `MailTransport.send` before it, and an
 * `AbortSignal` would be advisory even if it existed: nothing forces a real
 * provider, or a test double, to check it. This is the fourth call site in
 * this project with that exact shape (`callWithDeadline` in
 * `src/orchestrator/run-plan.ts`, `withDeadline` in `src/governance/
 * notify.ts`, a second `withDeadline` in `src/whatsapp/messenger.ts`), so a
 * fourth local copy rather than a shared import — the same choice each prior
 * site made, because each one wraps a different promise with a different
 * fallback and there is nothing to factor out beyond a few lines of shape.
 * What makes this one load-bearing rather than cosmetic: production calls
 * this from inside `schedulerPass` (spec §7.8) — one sequential await chain
 * that also runs `expireOverdue` and every due plan. An unbounded await here
 * does not delay one voice note; it stalls the owner's entire approval queue
 * for as long as the provider hangs, for exactly as long as a stranger's
 * voice note sits with a wedged endpoint.
 *
 * **Fix round A — `msg.downloadAudio()` carried the identical hazard this
 * docblock already named, unguarded.** The paragraph above described the
 * danger precisely and then the function below raced only the provider
 * call, leaving the media fetch — which runs first, inside the same
 * sequential pass — to hang forever against a slow or wedged media URL.
 * `downloadAudio` is reused by `withDeadline` below for the same reason: no
 * `AbortSignal` on the interface, same advisory-signal problem, same fix.
 *
 * **And a byte cap alongside it, because the duration check cannot gate the
 * download.** `maxSeconds` is read FROM the already-downloaded result
 * (`{ bytes, mimeType, seconds }` all arrive together) — by the time
 * `seconds` is known, every byte has already been pulled into memory. A
 * provider that reports a short `seconds` for a large payload (lying,
 * miscounting, or simply serving the wrong resource) is not caught by the
 * duration check at all. `MAX_AUDIO_DOWNLOAD_BYTES` checks the thing that is
 * actually true the instant the download resolves — how large it really
 * was — before anything downstream (the paid provider call, holding the
 * buffer any longer than necessary) happens.
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
  /**
   * The downloaded media exceeded `MAX_AUDIO_DOWNLOAD_BYTES` — see this
   * module's own docblock on why the duration check cannot catch this.
   * Separate from `'too_long'` on purpose: the two are independent signals
   * (a provider can misreport one without the other), and conflating them
   * would report "the recording is too long" for a result that may not be
   * long at all.
   */
  | { status: 'too_large'; bytes: number }
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
 * How long `transcribeInbound` waits for the provider before giving up.
 *
 * Matches `ADAPTER_TIMEOUT_MS` in `src/orchestrator/run-plan.ts` rather than
 * the much shorter `SEND_TIMEOUT_MS`/`NOTIFY_TIMEOUT_MS` (5s) in
 * `messenger.ts`/`notify.ts`: those two are courtesy acknowledgements to a
 * channel that is either up or down, while this call, like an adapter call,
 * is the real work — an external service actually processing audio, which
 * can legitimately take tens of seconds against a healthy provider.
 */
const TRANSCRIBE_TIMEOUT_MS = 60_000;

/**
 * How long `transcribeInbound` waits for `msg.downloadAudio()` before giving
 * up — fix round A, finding 5. Same order of magnitude as
 * `TRANSCRIBE_TIMEOUT_MS`, for the same reason: fetching a media file from
 * the provider's URL is real external work, not a courtesy acknowledgement
 * to a channel that is simply up or down, so it sits with the 60s class
 * (`ADAPTER_TIMEOUT_MS`, `TRANSCRIBE_TIMEOUT_MS`) rather than the 5s one
 * (`SEND_TIMEOUT_MS`/`NOTIFY_TIMEOUT_MS`/`ALERT_TIMEOUT_MS`). It is the
 * worst-case bound on TIME; `MAX_AUDIO_DOWNLOAD_BYTES` below is the
 * independent bound on SIZE that this deadline alone cannot provide, since
 * a fast connection can deliver an oversized file well within 60s.
 */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * The largest download `transcribeInbound` accepts from `msg.downloadAudio()`
 * before refusing it outright — fix round A, finding 5.
 *
 * Derived from `config.whatsappMaxAudioSeconds` (default 180s), not invented
 * independently: a WhatsApp voice note is opus-encoded at tens of kbps, so
 * even a generously high estimate — an order of magnitude above typical
 * voice bitrates — comes nowhere near this figure for a legitimate
 * recording at the length cap. This bound exists for the case the length
 * cap cannot reach at all: `seconds` is read FROM the already-downloaded
 * result, so a provider that misreports it (or serves the wrong resource
 * under the `audio` kind) is caught here, by what is actually true the
 * instant the bytes arrive, not by a number the provider chose to report.
 * 20 MB matches the order of magnitude this project already accepts for an
 * uploaded document (`MAX_ORIGINAL_BYTES`, `src/documents/ingest.ts`, 25 MB)
 * rather than inventing a new scale for one more kind of untrusted payload.
 */
const MAX_AUDIO_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Bound a promise the callee might never settle.
 *
 * Mirrors `withDeadline` in `src/governance/notify.ts` and
 * `src/whatsapp/messenger.ts` (itself mirroring `callWithDeadline` in
 * `src/orchestrator/run-plan.ts`) — same bug, same fix, now the call site
 * for both the provider call and `msg.downloadAudio()` within this module.
 * An `AbortSignal` is advisory only: nothing forces a provider
 * implementation, a media host, or a test double, to check it, so racing
 * the call itself against an independent timer is what actually binds the
 * wait. `label` names which external call timed out — this module waits on
 * two different ones, and a single hardcoded message would misname half of
 * its own failures.
 */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

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
 * Each sender kind's own daily ceiling — one table, so the budget a sender
 * draws from and the provenance that silos its count (`provenanceOf` above)
 * can never be updated one without the other. Fix round 1's Important 2
 * flagged a `senderKind === 'principal' ? … : …` ternary living apart from
 * `provenanceOf`'s own as exactly the kind of two-places-that-must-agree
 * this project has been burned by before.
 */
const DAILY_CAP: Record<SenderKind, () => number> = {
  principal: () => config.whatsappTranscribeBossPerDay,
  other: () => config.whatsappTranscribeOtherPerDay,
};

/**
 * How many transcription attempts this sender kind has made today —
 * successful or failed, because a failed attempt still called the provider.
 * Counts `audit_log` rows; see this module's own docblock for why, and for
 * why the kind filter is `whatsapp_transcription` specifically.
 */
export async function whatsappTranscriptionsToday(
  senderKind: SenderKind,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<number> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log
      WHERE business_id = $1 AND kind = 'whatsapp_transcription' AND provenance = $2
        AND at >= date_trunc('day', now())`,
    [businessId, provenanceOf(senderKind)],
  );
  return Number(rows[0]?.n ?? '0');
}

export async function transcribeInbound(
  msg: NormalizedInboundMessage,
  senderKind: SenderKind,
  options: {
    businessId: string;
    provider: TranscriptionProvider;
    maxSeconds?: number;
    /**
     * Overrides `MAX_AUDIO_DOWNLOAD_BYTES` for one call. Production never
     * passes this; same test-only escape hatch as `maxSeconds`, for the
     * same reason — a test proves the refusal without building a 20 MB
     * fixture.
     */
    maxBytes?: number;
    /**
     * Overrides `TRANSCRIBE_TIMEOUT_MS` for one call. Production never
     * passes this; it exists so a test can prove the race without waiting
     * out a real 60s timer — the same escape hatch `adapterTimeoutMs`
     * (`src/orchestrator/run-plan.ts`) already gives `ADAPTER_TIMEOUT_MS`,
     * same order of magnitude, same reason.
     */
    timeoutMs?: number;
    /**
     * Overrides `DOWNLOAD_TIMEOUT_MS` for one call. Same reason and same
     * production discipline as `timeoutMs` above — a separate override
     * because the download and the provider call are raced independently,
     * against independent fallback values.
     */
    downloadTimeoutMs?: number;
  },
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

  // ORDER MATTERS: download (raced against its own deadline), then the byte
  // cap, then the length cap, then the daily cap, then the provider call,
  // then the audit row. The byte cap runs immediately once the download
  // resolves, before the length check, because it is the cheaper and more
  // fundamental refusal — a payload this project will not hold onto a
  // moment longer than it takes to measure it, independent of what the
  // provider claims about its duration (see `MAX_AUDIO_DOWNLOAD_BYTES`'s own
  // docblock on why the length check cannot substitute for it). The daily
  // cap still runs before the provider call, because that call is the one
  // that spends money.
  const { bytes, mimeType, seconds } = await withDeadline(
    msg.downloadAudio(),
    options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    'audio download',
  );

  const maxBytes = options.maxBytes ?? MAX_AUDIO_DOWNLOAD_BYTES;
  if (bytes.length > maxBytes) {
    return { status: 'too_large', bytes: bytes.length };
  }

  const maxSeconds = options.maxSeconds ?? config.whatsappMaxAudioSeconds;
  if (seconds > maxSeconds) {
    return { status: 'too_long', seconds };
  }

  const perDay = DAILY_CAP[senderKind]();
  const usedToday = await whatsappTranscriptionsToday(senderKind, { businessId });
  if (usedToday >= perDay) {
    return { status: 'capped' };
  }

  try {
    const result = await withDeadline(
      provider({ bytes, mimeType }),
      options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS,
      'transcription provider',
    );
    const text = result.text.trim();
    if (text === '') {
      await recordAttempt(businessId, senderKind, { succeeded: false, seconds, textLength: 0 });
      return { status: 'failed', reason: CANNOT_UNDERSTAND };
    }
    await recordAttempt(businessId, senderKind, { succeeded: true, seconds, textLength: text.length });
    return { status: 'transcribed', text };
  } catch {
    // The error itself is never recorded or surfaced — see the module
    // docblock on never guessing and `src/domain/audit.ts`'s
    // `whatsapp_transcription` entry on never carrying anything but counts
    // and the sender kind. An upstream error message (or a timeout message
    // naming nothing sensitive, but still just noise to a human) is neither.
    await recordAttempt(businessId, senderKind, { succeeded: false, seconds, textLength: 0 });
    return { status: 'failed', reason: CANNOT_UNDERSTAND };
  }
}

/**
 * The one audit row a transcription attempt produces, success or failure
 * alike. Carries counts (duration, character count) and the sender kind —
 * via `provenance`, not the message body, not the transcript. See
 * `src/domain/audit.ts`'s `whatsapp_transcription` entry for the full
 * reasoning.
 *
 * The write itself is wrapped and swallowed on failure, matching
 * `recordCurationFailure` (`src/memory/curate.ts`) rather than `trip()`'s
 * throw-with-the-outcome pattern (`src/governance/killswitch.ts`) — fix
 * round 1's Minor 4. The two precedents exist for different stakes:
 * `trip()` is a binary safety switch where a caller catching a dedicated
 * error can still act on the fact that the trip itself landed. Here, the
 * value this function's caller needs most is the transcript (or the honest
 * failure) already sitting in hand from the provider call above — an owner's
 * dictated instruction must not be thrown away because a transient write to
 * `audit_log` failed a moment later. The cost of swallowing is a budget
 * under-count for exactly this one call, which a human can still see and
 * correct; the cost of not swallowing is losing the instruction outright.
 */
async function recordAttempt(
  businessId: string,
  senderKind: SenderKind,
  counts: { succeeded: boolean; seconds: number; textLength: number },
): Promise<void> {
  try {
    await appendAudit(
      {
        actor: 'orchestrator',
        kind: 'whatsapp_transcription',
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
  } catch {
    // Swallowed on purpose — see the docblock above.
  }
}
