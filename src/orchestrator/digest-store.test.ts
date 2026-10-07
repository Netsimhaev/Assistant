import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../test/db.js';
import { lastWindowEnd, recentDigests, recordChannel, storeDigest } from './digest-store.js';

const BUSINESS = 'test-business';
const WINDOW = {
  kind: 'daily' as const,
  start: new Date('2026-10-06T08:00:00+03:00'),
  end: new Date('2026-10-07T08:00:00+03:00'),
  windowsCovered: 1,
};

describe('digest store', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  /**
   * Spec §2 decision 4: the body is read back VERBATIM. If storage round-tripped
   * through a recomputation, last Tuesday's digest would show today's numbers
   * and stop being a record of what the owner was told.
   */
  it('reads the body back exactly as it was stored', async () => {
    const body = 'תדריך יומי · 06/10–07/10\n\nלא קרה כלום בתקופה הזו.';
    const stored = await storeDigest(
      { window: WINDOW, rendered: { body, hadContent: false } },
      { businessId: BUSINESS },
    );
    const back = await recentDigests({ businessId: BUSINESS });
    expect(back).toHaveLength(1);
    expect(back[0]?.body).toBe(body);
    expect(back[0]?.digestId).toBe(stored.digestId);
  });

  /**
   * Spec §6: NULL means the channel was never asked for; a state means it was
   * wanted. "Not sent" and "nothing to send" must not look alike.
   */
  it('leaves an unasked channel null and records an asked one', async () => {
    const stored = await storeDigest(
      { window: WINDOW, rendered: { body: 'x', hadContent: true } },
      { businessId: BUSINESS },
    );
    expect(stored.emailState).toBeNull();

    await recordChannel(stored.digestId, 'email', 'skipped_not_connected', { businessId: BUSINESS });
    const back = await recentDigests({ businessId: BUSINESS });
    expect(back[0]?.emailState).toBe('skipped_not_connected');
    expect(back[0]?.whatsappState).toBeNull();
  });

  it('reports the last window end per kind, not across kinds', async () => {
    await storeDigest({ window: WINDOW, rendered: { body: 'a', hadContent: true } }, { businessId: BUSINESS });
    expect((await lastWindowEnd('daily', { businessId: BUSINESS }))?.toISOString())
      .toBe(WINDOW.end.toISOString());
    expect(await lastWindowEnd('weekly', { businessId: BUSINESS })).toBeNull();
  });

  it('keeps one business out of another', async () => {
    await storeDigest({ window: WINDOW, rendered: { body: 'a', hadContent: true } }, { businessId: BUSINESS });
    expect(await recentDigests({ businessId: 'other-business' })).toEqual([]);
  });

  /**
   * `recordChannel` on an id that matches no row must THROW, not pass quietly.
   * A silent miss means the delivery outcome of a digest the owner received is
   * lost, and nothing would ever say so — the same rule `settleMessage` and
   * `markContentIngested` already carry.
   */
  it('throws when asked to record a channel for a digest that does not exist', async () => {
    await expect(
      recordChannel('DG-nope', 'email', 'sent', { businessId: BUSINESS }),
    ).rejects.toThrow();
  });
});
