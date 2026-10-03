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
 * Writes a `whatsapp` audit row directly, bypassing `transcribeInbound`
 * entirely — this is what proves the daily cap is read from `audit_log`
 * itself rather than from any counter `transcribeInbound` might keep.
 */
async function seedWhatsappAuditRow(businessId: string, senderKind: SenderKind): Promise<void> {
  await appendAudit(
    {
      actor: 'orchestrator',
      kind: 'whatsapp',
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

  it('refuses audio longer than the cap, and says how long it was', async () => {
    const outcome = await transcribeInbound(audioMsg({ seconds: 200 }), 'principal', {
      businessId: BUSINESS, provider: ok,
    });
    expect(outcome).toEqual({ status: 'too_long', seconds: 200 });
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

  /** No secret, no audio, no transcript in the audit row. */
  it('writes an audit row carrying counts and the sender kind only', async () => {
    const outcome = await transcribeInbound(audioMsg(), 'principal', { businessId: BUSINESS, provider: ok });
    expect(outcome.status).toBe('transcribed');

    const entries = await queryAudit({ businessId: BUSINESS, kind: 'whatsapp' });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.provenance).toBe('boss');
    expect(entry?.actionClass).toBeNull();

    const serialised = JSON.stringify(entry, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value);
    expect(serialised).not.toContain('שלח לדנה');
    expect(serialised).not.toContain('fake-audio-bytes');
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
