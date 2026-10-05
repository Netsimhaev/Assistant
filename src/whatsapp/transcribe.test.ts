import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { appendAudit, queryAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import type { NormalizedInboundMessage } from './gateway.js';
import type { SenderKind } from './store.js';
import {
  transcribeInbound, whatsappTranscriptionsToday, type TranscriptionProvider,
} from './transcribe.js';

const BUSINESS = 'test-business';

const ok: TranscriptionProvider = async () => ({ text: 'שלח לדנה את ההצעה עד חמישי' });

function audioMsg(overrides: { seconds?: number } = {}): NormalizedInboundMessage {
  return {
    providerMessageId: `wamid.${Math.random().toString(36).slice(2)}`,
    senderNumber: '+972541234567',
    body: null,
    mediaKind: 'audio',
    providerTimestamp: new Date().toISOString(),
    downloadAudio: async () => ({
      bytes: Buffer.from('fake-audio-bytes'),
      mimeType: 'audio/ogg',
      seconds: overrides.seconds ?? 10,
    }),
  };
}

/**
 * Writes a `whatsapp_transcription` audit row directly, bypassing
 * `transcribeInbound` entirely — this is what proves the daily cap is read
 * from `audit_log` itself rather than from any counter `transcribeInbound`
 * might keep.
 */
async function seedWhatsappAuditRow(businessId: string, senderKind: SenderKind): Promise<void> {
  await appendAudit(
    {
      actor: 'orchestrator',
      kind: 'whatsapp_transcription',
      charterVersion: 'n/a',
      provenance: senderKind === 'principal' ? 'boss' : 'unknown_external',
      inputHash: canonicalHash({ seeded: true, senderKind }),
      artifacts: [],
      costMinor: null,
      tokens: null,
      reason: 'seed row for test',
    },
    { businessId },
  );
}

describe('transcribeInbound', () => {
  beforeEach(async () => { await resetDatabase(); });
  afterAll(async () => { await closePool(); });

  /**
   * TWO BUDGETS, AND THIS IS WHY. Shared, a customer sending fifty voice
   * notes exhausts the budget and the OWNER'S OWN recording then goes
   * untranscribed — a stranger degrading the owner's channel. The owner's
   * budget is reserved.
   */
  it('does not let a flood of non-principal audio stop the principal being transcribed', async () => {
    for (let i = 0; i < 20; i += 1) await seedWhatsappAuditRow(BUSINESS, 'other');
    const other = await transcribeInbound(audioMsg(), 'other', { businessId: BUSINESS, provider: ok });
    expect(other.status).toBe('capped');
    const boss = await transcribeInbound(audioMsg(), 'principal', { businessId: BUSINESS, provider: ok });
    expect(boss.status).toBe('transcribed');
  });

  /**
   * Rows seeded directly, never through `transcribeInbound`, still trip the
   * cap — which could not happen if the cap were read from a counter that
   * only `transcribeInbound` itself updates. The source is the table.
   */
  it('counts the cap from audit rows, not from a maintained counter', async () => {
    for (let i = 0; i < 40; i += 1) await seedWhatsappAuditRow(BUSINESS, 'principal');
    expect(await whatsappTranscriptionsToday('principal', { businessId: BUSINESS })).toBe(40);

    const outcome = await transcribeInbound(audioMsg(), 'principal', { businessId: BUSINESS, provider: ok });
    expect(outcome.status).toBe('capped');
  });

  /**
   * Fix round 1, Minor 2. Seeding 40 principal rows (above) exceeds BOTH the
   * real boss cap (40) and a wrongly-merged "same cap as other" (20), so
   * that test alone cannot tell the two apart. This seeds 21 — over the
   * other-sender cap, still under the real boss cap — so a regression that
   * quietly reused `whatsappTranscribeOtherPerDay` for the principal would
   * turn this `'transcribed'` into `'capped'`.
   */
  it('reserves the principal a budget larger than the other-sender cap', async () => {
    for (let i = 0; i < 21; i += 1) await seedWhatsappAuditRow(BUSINESS, 'principal');
    const outcome = await transcribeInbound(audioMsg(), 'principal', { businessId: BUSINESS, provider: ok });
    expect(outcome.status).toBe('transcribed');
  });

  /**
   * Fix round 1, Important 2. The count is scoped to
   * `kind = 'whatsapp_transcription'` specifically, not to every row that
   * happens to share the sender's provenance. This stands in for the exact
   * collision the review named: a future WhatsApp-instruction audit row
   * would also carry `provenance: 'boss'` for the owner's own messages, and
   * must not spend his transcription budget. The real instruction kind
   * doesn't exist yet (a later task's job), so an existing, unrelated kind
   * (`tool_call`) stands in for "some other boss-provenance event" here —
   * the property under test is the kind filter, not what that future kind
   * will be named.
   */
  it('does not count an audit row of a different kind toward the transcription budget', async () => {
    await appendAudit(
      {
        actor: 'orchestrator',
        kind: 'tool_call',
        charterVersion: 'n/a',
        provenance: 'boss',
        inputHash: canonicalHash({ unrelated: true }),
        artifacts: [],
        costMinor: null,
        tokens: null,
        reason: 'some other boss-provenance event, not a transcription',
      },
      { businessId: BUSINESS },
    );
    expect(await whatsappTranscriptionsToday('principal', { businessId: BUSINESS })).toBe(0);
  });

  /**
   * Fix round 1, Minor 1. `maxSeconds` previously appeared in no test: the
   * default (180) alone would have passed this with `seconds: 200` even if
   * the override were deleted. Here `seconds: 10` only exceeds the cap
   * because `maxSeconds: 5` is actually read.
   */
  it('refuses audio longer than the cap, and says how long it was', async () => {
    const outcome = await transcribeInbound(audioMsg({ seconds: 10 }), 'principal', {
      businessId: BUSINESS, provider: ok, maxSeconds: 5,
    });
    expect(outcome).toEqual({ status: 'too_long', seconds: 10 });
  });

  /**
   * Fix round A, finding 5 (renamed and re-derived, fix round B, finding 1).
   * The duration check alone cannot catch an oversized download: `seconds`
   * is read FROM the already-downloaded result, so a provider reporting a
   * short duration for a large payload sails past `maxSeconds` entirely.
   * `maxBytes: 5` stands in for `MAX_TRANSCRIBABLE_AUDIO_BYTES` (3 MB in
   * production) so this proves the refusal is genuinely keyed on the byte
   * count — `audioMsg`'s fixed `'fake-audio-bytes'` payload (17 bytes)
   * exceeds it — not on `seconds`, which here reports a perfectly
   * ordinary 10.
   */
  it('refuses audio whose download exceeds the byte cap, independent of its reported duration', async () => {
    const outcome = await transcribeInbound(audioMsg({ seconds: 10 }), 'principal', {
      businessId: BUSINESS, provider: ok, maxBytes: 5,
    });
    expect(outcome).toEqual({ status: 'too_large', bytes: 'fake-audio-bytes'.length });
  });

  /**
   * Fix round B, finding 1 — pins the PRODUCTION default itself, not an
   * override. Every other byte-cap test above injects `maxBytes` so the
   * fixture need not be multi-megabyte; this one deliberately omits it to
   * prove `MAX_TRANSCRIBABLE_AUDIO_BYTES` (3 MB) actually bites at
   * production scale — the review's own finding was that the PREVIOUS
   * value (20 MB, named `MAX_AUDIO_DOWNLOAD_BYTES`) was 30-50x the
   * derivation it cited and nothing real audio could ever reach, so a
   * test that only ever overrode the constant could not have caught that.
   * 3.5 MB sits just above the new cap and nowhere near the old one.
   */
  it('refuses a 3.5 MB download under the real production byte cap, which the old 20 MB value never would have', async () => {
    const msg = audioMsg({ seconds: 10 });
    msg.downloadAudio = async () => ({
      bytes: Buffer.alloc(Math.ceil(3.5 * 1024 * 1024), 0x61),
      mimeType: 'audio/ogg',
      seconds: 10,
    });
    const outcome = await transcribeInbound(msg, 'principal', { businessId: BUSINESS, provider: ok });
    expect(outcome.status).toBe('too_large');
  });

  /**
   * Fix round A, finding 5. `msg.downloadAudio()` carried the identical
   * unbounded-await hazard this module's own docblock already named for the
   * provider call, left unguarded. `downloadTimeoutMs` stands in for
   * `DOWNLOAD_TIMEOUT_MS` (60s in production) so this proves the race
   * without waiting out a real 60-second timer — same pattern as the
   * provider-hang test below.
   *
   * This REJECTS rather than returning `{ status: 'failed' }` — the
   * download call sits outside `transcribeInbound`'s own `try` (same as a
   * download that throws for any other reason; see
   * `whatsapp-door.test.ts`'s "tells the owner and settles failed when
   * downloading the recording itself throws", which already relies on this
   * propagating as a throw for the DOOR's own `catch` to handle). What
   * matters here is that it rejects WITHIN the deadline instead of hanging
   * forever — a media URL that never answers must not freeze the whole
   * `schedulerPass` sequential await chain this runs inside.
   */
  it('gives up on a download that never settles, within the deadline, instead of hanging forever', async () => {
    const msg = audioMsg();
    msg.downloadAudio = () => new Promise(() => { /* never settles */ });
    await expect(
      transcribeInbound(msg, 'principal', {
        businessId: BUSINESS,
        provider: ok,
        downloadTimeoutMs: 25,
      }),
    ).rejects.toThrow(/did not finish within/);
  });

  /** Never guesses. A failed transcription is a failure, not a best-effort string. */
  it('reports failure rather than inventing text when the provider throws', async () => {
    const outcome = await transcribeInbound(audioMsg(), 'principal', {
      businessId: BUSINESS, provider: async () => { throw new Error('upstream 503'); },
    });
    expect(outcome.status).toBe('failed');
  });

  /**
   * A provider that answers but returns nothing usable is not an error it
   * will throw for us — it is a successful call with empty content, and
   * this must still be read as a failure rather than reported as text.
   */
  it('reports failure rather than transcribing empty or whitespace-only text', async () => {
    const outcome = await transcribeInbound(audioMsg(), 'principal', {
      businessId: BUSINESS, provider: async () => ({ text: '   ' }),
    });
    expect(outcome.status).toBe('failed');
  });

  /**
   * A provider that charged and then failed still charged — the daily cap
   * must advance for a failed attempt exactly as it does for a successful
   * one, the same reasoning `recordCurationFailure` is built on.
   */
  it('writes an audit row on the failure path too', async () => {
    await transcribeInbound(audioMsg(), 'principal', {
      businessId: BUSINESS, provider: async () => { throw new Error('upstream 503'); },
    });
    expect(await whatsappTranscriptionsToday('principal', { businessId: BUSINESS })).toBe(1);
  });

  /**
   * Fix round 1, Important 1. `transcribeInbound` runs inside
   * `schedulerPass` in production (spec §7.8) — a provider that never
   * settles must not hang the whole pass, which also expires overdue
   * approvals and runs every other due plan. `timeoutMs` stands in for
   * `TRANSCRIBE_TIMEOUT_MS` (60s in production) so this proves the race
   * without waiting out a real 60-second timer — the same pattern
   * `adapterTimeoutMs` already uses in `src/orchestrator/external.test.ts`.
   */
  it('gives up on a provider that never settles, within the deadline, instead of hanging forever', async () => {
    const outcome = await transcribeInbound(audioMsg(), 'principal', {
      businessId: BUSINESS,
      provider: () => new Promise(() => { /* never settles */ }),
      timeoutMs: 25,
    });
    expect(outcome.status).toBe('failed');
  });

  /**
   * No secret, no audio, no transcript, and no identifying detail in the
   * audit row. Fix round 1, Minor 3: the previous version only asserted
   * what the row lacks — an empty `reason` would have passed it — and never
   * checked the sender's phone number, which is exactly the kind of
   * identifier `erasure-invariants.test.ts` depends on `audit_log` never
   * carrying, since that table is one of only three an erasure cannot
   * reach. This now also asserts the counts are actually present, and that
   * the sender's number is actually absent.
   */
  it('writes an audit row carrying counts and the sender kind only', async () => {
    const msg = audioMsg({ seconds: 10 });
    const outcome = await transcribeInbound(msg, 'principal', { businessId: BUSINESS, provider: ok });
    expect(outcome.status).toBe('transcribed');
    if (outcome.status !== 'transcribed') throw new Error('unreachable');

    const entries = await queryAudit({ businessId: BUSINESS, kind: 'whatsapp_transcription' });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.provenance).toBe('boss');
    expect(entry?.actionClass).toBeNull();

    // The counts are genuinely present, not just "nothing bad is present".
    expect(entry?.reason).toContain('10');
    expect(entry?.reason).toContain(String(outcome.text.length));

    const serialised = JSON.stringify(entry, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value);
    expect(serialised).not.toContain('שלח לדנה');
    expect(serialised).not.toContain('fake-audio-bytes');
    expect(serialised).not.toContain('972541234567');
  });

  /** The two budgets are independent per business, same as every other cap here. */
  it('confines each business to its own daily budget', async () => {
    for (let i = 0; i < 20; i += 1) await seedWhatsappAuditRow(BUSINESS, 'other');
    const sameBusiness = await transcribeInbound(audioMsg(), 'other', { businessId: BUSINESS, provider: ok });
    expect(sameBusiness.status).toBe('capped');

    const otherBusiness = await transcribeInbound(audioMsg(), 'other', { businessId: 'other-business', provider: ok });
    expect(otherBusiness.status).toBe('transcribed');
  });
});
