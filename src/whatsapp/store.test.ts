import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  claimMessage, conversation, recordInbound, recordOutbound, settleMessage, unclaimedInbound,
} from './store.js';

const BUSINESS = 'test-business';
const base = {
  senderNumber: '+972541234567',
  senderKind: 'principal' as const,
  body: 'שלח לדנה',
  mediaKind: null,
  providerTimestamp: '2026-10-03T09:00:00.000Z',
};

describe('whatsapp store', () => {
  beforeEach(async () => { await resetDatabase(); });
  afterAll(async () => { await closePool(); });

  /**
   * The dedupe is the unique index, not a prior read. GREEN-API redelivering a
   * message must not produce a second instruction, and "we probably saw this"
   * is not a control.
   */
  it('records an inbound message once, and returns null for a redelivery', async () => {
    const first = await recordInbound({ ...base, providerMessageId: 'wamid.1' }, { businessId: BUSINESS });
    expect(first).not.toBeNull();
    const second = await recordInbound({ ...base, providerMessageId: 'wamid.1' }, { businessId: BUSINESS });
    expect(second).toBeNull();
    expect(await conversation({ businessId: BUSINESS })).toHaveLength(1);
  });

  /**
   * The claim is what makes a crash lose one instruction instead of sending a
   * second email. Two concurrent claims on one row: exactly one wins.
   */
  it('lets exactly one caller claim a message', async () => {
    const msg = await recordInbound({ ...base, providerMessageId: 'wamid.2' }, { businessId: BUSINESS });
    if (msg === null) throw new Error('unreachable');
    const [a, b] = await Promise.all([
      claimMessage(msg.id, { businessId: BUSINESS }),
      claimMessage(msg.id, { businessId: BUSINESS }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('hands out unclaimed inbound oldest first, and stops offering a claimed one', async () => {
    await recordInbound({ ...base, providerMessageId: 'w.late', providerTimestamp: '2026-10-03T09:05:00.000Z' }, { businessId: BUSINESS });
    const early = await recordInbound({ ...base, providerMessageId: 'w.early', providerTimestamp: '2026-10-03T09:01:00.000Z' }, { businessId: BUSINESS });
    if (early === null) throw new Error('unreachable');

    const queue = await unclaimedInbound({ businessId: BUSINESS });
    expect(queue.map((m) => m.providerMessageId)).toEqual(['w.early', 'w.late']);

    await claimMessage(early.id, { businessId: BUSINESS });
    expect((await unclaimedInbound({ businessId: BUSINESS })).map((m) => m.providerMessageId)).toEqual(['w.late']);
  });

  it('settles a message with its transcript and job, and keeps outbound in the conversation', async () => {
    const msg = await recordInbound({ ...base, providerMessageId: 'w.3', body: null, mediaKind: 'audio' }, { businessId: BUSINESS });
    if (msg === null) throw new Error('unreachable');
    await claimMessage(msg.id, { businessId: BUSINESS });
    await settleMessage(msg.id, 'handled', { transcript: 'שלח לדנה', jobId: 'J-1' }, { businessId: BUSINESS });
    await recordOutbound({ body: 'קיבלתי.', jobId: 'J-1' }, { businessId: BUSINESS });

    const convo = await conversation({ businessId: BUSINESS });
    expect(convo).toHaveLength(2);
    expect(convo[0]?.transcript).toBe('שלח לדנה');
    expect(convo[0]?.state).toBe('handled');
    expect(convo[1]?.direction).toBe('outbound');
  });

  /** One business must never read another's conversation. */
  it('confines every read to its own business', async () => {
    await recordInbound({ ...base, providerMessageId: 'w.4' }, { businessId: BUSINESS });
    expect(await conversation({ businessId: 'other-business' })).toEqual([]);
    expect(await unclaimedInbound({ businessId: 'other-business' })).toEqual([]);
  });
});
