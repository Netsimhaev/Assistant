import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  claimForReport, claimMessage, conversation, recordInbound, recordOutbound, settleMessage,
  unclaimedInbound,
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
    // `recordOutbound` stamps `provider_timestamp` with `now()` (the brief's
    // own interface has no field to pass one in), so the inbound half has to
    // be seeded relative to the wall clock rather than at a fixed past
    // instant — otherwise the ordering assertion below is only true while
    // the suite happens to run after 09:00 UTC on 2026-10-03 (fix round 1,
    // Minor 9).
    const past = new Date(Date.now() - 60_000).toISOString();
    const msg = await recordInbound(
      { ...base, providerMessageId: 'w.3', body: null, mediaKind: 'audio', providerTimestamp: past },
      { businessId: BUSINESS },
    );
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

  /**
   * Fix round 1, Important 3. A silent miss would leave the message
   * `claimed` forever: `unclaimedInbound` only ever offers `received`, so
   * nothing re-offers it, no retry path exists, and nothing logs. Same
   * reasoning `markContentIngested` (`src/documents/read.ts`) already
   * applies to its own `UPDATE`.
   */
  it('throws when settling an id that matches no row', async () => {
    await expect(
      settleMessage('WA-does-not-exist', 'handled', {}, { businessId: BUSINESS }),
    ).rejects.toThrow();
  });

  /** One business must never read another's conversation. */
  it('confines every read to its own business', async () => {
    await recordInbound({ ...base, providerMessageId: 'w.4' }, { businessId: BUSINESS });
    expect(await conversation({ businessId: 'other-business' })).toEqual([]);
    expect(await unclaimedInbound({ businessId: 'other-business' })).toEqual([]);
  });
});

/**
 * Task 8, fix round 1 — `claimForReport` had no unit test of its own before
 * this (the review's finding 4: exercised only indirectly through
 * `whatsapp-report.test.ts`'s report-once test). These pin the two claim
 * kinds directly, including the state-guard mutation the review named as the
 * fourth extra mutation: widen either `WHERE ... state IN (...)` and the
 * first test below starts passing a message it should refuse.
 */
describe('claimForReport', () => {
  beforeEach(async () => { await resetDatabase(); });
  afterAll(async () => { await closePool(); });

  async function stateOf(id: string): Promise<string> {
    const { rows } = await getPool().query<{ state: string }>(
      'SELECT state FROM whatsapp_messages WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('expected a whatsapp_messages row');
    return row.state;
  }

  it('refuses to claim a message that has not been settled yet — still received or claimed', async () => {
    const received = await recordInbound({ ...base, providerMessageId: 'w.5' }, { businessId: BUSINESS });
    if (received === null) throw new Error('unreachable');
    expect(await claimForReport(received.id, 'interim', { businessId: BUSINESS })).toBe(false);
    expect(await claimForReport(received.id, 'terminal', { businessId: BUSINESS })).toBe(false);
    expect(await stateOf(received.id)).toBe('received');

    await claimMessage(received.id, { businessId: BUSINESS });
    expect(await claimForReport(received.id, 'interim', { businessId: BUSINESS })).toBe(false);
    expect(await claimForReport(received.id, 'terminal', { businessId: BUSINESS })).toBe(false);
    expect(await stateOf(received.id)).toBe('claimed');
  });

  it('moves handled/failed to reported_interim on an interim claim, exactly once', async () => {
    const msg = await recordInbound({ ...base, providerMessageId: 'w.6' }, { businessId: BUSINESS });
    if (msg === null) throw new Error('unreachable');
    await claimMessage(msg.id, { businessId: BUSINESS });
    await settleMessage(msg.id, 'handled', {}, { businessId: BUSINESS });

    expect(await claimForReport(msg.id, 'interim', { businessId: BUSINESS })).toBe(true);
    expect(await stateOf(msg.id)).toBe('reported_interim');

    // Report-once for the interim notice itself: a second interim claim on
    // the same message must not succeed a second time.
    expect(await claimForReport(msg.id, 'interim', { businessId: BUSINESS })).toBe(false);
    expect(await stateOf(msg.id)).toBe('reported_interim');
  });

  it('moves reported_interim to reported on a terminal claim — the owed second report', async () => {
    const msg = await recordInbound({ ...base, providerMessageId: 'w.7' }, { businessId: BUSINESS });
    if (msg === null) throw new Error('unreachable');
    await claimMessage(msg.id, { businessId: BUSINESS });
    await settleMessage(msg.id, 'handled', {}, { businessId: BUSINESS });
    await claimForReport(msg.id, 'interim', { businessId: BUSINESS });

    expect(await claimForReport(msg.id, 'terminal', { businessId: BUSINESS })).toBe(true);
    expect(await stateOf(msg.id)).toBe('reported');
  });

  it('moves handled/failed straight to reported on a terminal claim, skipping the interim state', async () => {
    const msg = await recordInbound({ ...base, providerMessageId: 'w.8' }, { businessId: BUSINESS });
    if (msg === null) throw new Error('unreachable');
    await claimMessage(msg.id, { businessId: BUSINESS });
    await settleMessage(msg.id, 'failed', {}, { businessId: BUSINESS });

    expect(await claimForReport(msg.id, 'terminal', { businessId: BUSINESS })).toBe(true);
    expect(await stateOf(msg.id)).toBe('reported');
  });

  it('refuses every further claim once a message is reported — the final state', async () => {
    const msg = await recordInbound({ ...base, providerMessageId: 'w.9' }, { businessId: BUSINESS });
    if (msg === null) throw new Error('unreachable');
    await claimMessage(msg.id, { businessId: BUSINESS });
    await settleMessage(msg.id, 'handled', {}, { businessId: BUSINESS });
    await claimForReport(msg.id, 'terminal', { businessId: BUSINESS });

    expect(await claimForReport(msg.id, 'interim', { businessId: BUSINESS })).toBe(false);
    expect(await claimForReport(msg.id, 'terminal', { businessId: BUSINESS })).toBe(false);
    expect(await stateOf(msg.id)).toBe('reported');
  });
});
