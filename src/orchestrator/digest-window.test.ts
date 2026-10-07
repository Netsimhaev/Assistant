import { describe, expect, it } from 'vitest';
import { DIGEST_DEFAULTS } from '../governance/digest-settings.js';
import { dueWindow } from './digest-window.js';

const TZ = 'Asia/Jerusalem';
const daily = { ...DIGEST_DEFAULTS, schedule: 'daily' as const, dailyHour: 8 };

describe('dueWindow', () => {
  /**
   * Spec §4: the switch is off by default, and off means nothing is ever due —
   * not "due but undelivered". A reader that returns a window for an off
   * schedule makes the switch cosmetic.
   */
  it('returns nothing while the schedule is off', () => {
    const off = { ...DIGEST_DEFAULTS, schedule: 'off' as const };
    expect(dueWindow(off, 'daily', null, new Date('2026-10-07T09:00:00+03:00'), TZ)).toBeNull();
  });

  it('returns nothing before the scheduled hour has passed', () => {
    const now = new Date('2026-10-07T07:30:00+03:00');
    expect(dueWindow(daily, 'daily', null, now, TZ)).toBeNull();
  });

  /**
   * Spec §5: the window is ANCHORED to the scheduled hour, not to the send
   * moment. Sent at 09:00 for an 08:00 schedule, the window still ends at
   * 08:00 — otherwise every late pass drags the anchor forward and the windows
   * drift until they overlap.
   */
  it('anchors the window to the scheduled hour even when the pass is late', () => {
    const now = new Date('2026-10-07T09:17:00+03:00');
    const window = dueWindow(daily, 'daily', null, now, TZ);
    expect(window).not.toBeNull();
    expect(window?.end.toISOString()).toBe(new Date('2026-10-07T08:00:00+03:00').toISOString());
    expect(window?.start.toISOString()).toBe(new Date('2026-10-06T08:00:00+03:00').toISOString());
    expect(window?.windowsCovered).toBe(1);
  });

  it('returns nothing once that window has already been sent', () => {
    const now = new Date('2026-10-07T09:17:00+03:00');
    const lastSent = new Date('2026-10-07T08:00:00+03:00');
    expect(dueWindow(daily, 'daily', lastSent, now, TZ)).toBeNull();
  });

  /**
   * Spec §5: several missed windows of the same kind become ONE digest that
   * declares the gap. Three retroactive dailies at once are noise; one that
   * admits the gap is information.
   */
  it('merges three missed days into one window that states how many it covers', () => {
    const now = new Date('2026-10-07T09:00:00+03:00');
    const lastSent = new Date('2026-10-04T08:00:00+03:00');
    const window = dueWindow(daily, 'daily', lastSent, now, TZ);
    expect(window?.start.toISOString()).toBe(lastSent.toISOString());
    expect(window?.end.toISOString()).toBe(new Date('2026-10-07T08:00:00+03:00').toISOString());
    expect(window?.windowsCovered).toBe(3);
  });

  /**
   * Spec §5: gap merging happens WITHIN a kind and never across them. A weekly
   * neither swallows missed dailies nor is made redundant by them — they answer
   * two different questions, and that overlap is deliberate.
   */
  it('computes the weekly window independently of the daily one', () => {
    const both = { ...DIGEST_DEFAULTS, schedule: 'both' as const, dailyHour: 8, weeklyDay: 0, weeklyHour: 8 };
    const now = new Date('2026-10-11T09:00:00+03:00'); // Sunday
    const weekly = dueWindow(both, 'weekly', null, now, TZ);
    expect(weekly).not.toBeNull();
    expect(weekly?.end.toISOString()).toBe(new Date('2026-10-11T08:00:00+03:00').toISOString());
    expect(weekly?.start.toISOString()).toBe(new Date('2026-10-04T08:00:00+03:00').toISOString());
  });

  it('returns nothing for a kind the schedule does not include', () => {
    const now = new Date('2026-10-11T09:00:00+03:00');
    expect(dueWindow(daily, 'weekly', null, now, TZ)).toBeNull();
  });

  /**
   * The time zone comes from the charter (spec §4), so "08:00" must be 08:00
   * THERE. Reading it in UTC would send the digest at the wrong hour for most
   * of the year and silently shift it twice a year with daylight saving.
   */
  it('reads the scheduled hour in the charter time zone, not in UTC', () => {
    const now = new Date('2026-10-07T06:30:00Z'); // 09:30 in Jerusalem
    expect(dueWindow(daily, 'daily', null, now, TZ)).not.toBeNull();
    expect(dueWindow(daily, 'daily', null, now, 'UTC')).toBeNull();
  });

  const weekly = { ...DIGEST_DEFAULTS, schedule: 'weekly' as const, weeklyDay: 0, weeklyHour: 8 };

  /**
   * Narrowing documented on `lastScheduledMoment`: a weekly is only ever
   * found due on its OWN scheduled weekday. Without the weekday gate, a
   * wider per-candidate scan (checking each candidate's own weekday over
   * several days back, the way the original draft of this function scanned
   * hours) would find last Sunday's moment on a Wednesday poll and report a
   * window three days early — no matter how many weeks of backlog exist.
   */
  it('stays null for a weekly polled on a non-scheduled weekday, however large the backlog', () => {
    const now = new Date('2026-10-07T09:00:00+03:00'); // Wednesday
    const lastSent = new Date('2026-09-13T08:00:00+03:00'); // three weeks of backlog
    expect(dueWindow(weekly, 'weekly', lastSent, now, TZ)).toBeNull();
  });

  /**
   * The companion to the test above: the backlog from being polled on the
   * "wrong" days isn't lost, it's absorbed. Once the scheduled weekday comes
   * back around, `start` is still the stale `lastSentEnd` and the two
   * missed weeks collapse into one window with `windowsCovered: 2` — a
   * reader that forgot to carry `lastSentEnd` through unchanged, or that
   * recomputed `start` from `end` instead, would lose the gap here.
   */
  it('fires the weekly on the next scheduled weekday, admitting the two-week gap', () => {
    const now = new Date('2026-10-04T09:00:00+03:00'); // Sunday
    const lastSent = new Date('2026-09-20T08:00:00+03:00'); // Sunday, two weeks earlier
    const window = dueWindow(weekly, 'weekly', lastSent, now, TZ);
    expect(window).not.toBeNull();
    expect(window?.end.toISOString()).toBe(new Date('2026-10-04T08:00:00+03:00').toISOString());
    expect(window?.start.toISOString()).toBe(lastSent.toISOString());
    expect(window?.windowsCovered).toBe(2);
  });

  /**
   * DST spring-forward: America/New_York skips 2am entirely on 2026-03-08
   * (clocks jump from 1:59am to 3:00am). `now` is chosen just after the
   * skip (03:30 local) so the backward probe, if it ignored which calendar
   * day it had drifted into, would reach all the way back to YESTERDAY's
   * valid 2am within its 25-hour bound — a reader without that calendar-day
   * guard would match it and report a digest for an hour that was never
   * scheduled today. This asserts the safe outcome instead: nothing is due
   * for the skipped day.
   */
  it('returns null for a scheduled hour that daylight saving skips entirely that day', () => {
    const springForward = { ...DIGEST_DEFAULTS, schedule: 'daily' as const, dailyHour: 2 };
    const now = new Date('2026-03-08T07:30:00Z'); // 03:30 local, just after the skip
    expect(dueWindow(springForward, 'daily', null, now, 'America/New_York')).toBeNull();
  });

  /**
   * `Asia/Kolkata` is UTC+5:30 — a half-hour offset. Truncating to the top
   * of the matched hour by subtracting `candidate.getTime() % 3_600_000`
   * (arithmetic on raw epoch milliseconds) only lands on the local hour
   * boundary when the zone's offset is a whole number of hours; in a
   * half-hour zone it lands 30 minutes into the PREVIOUS local hour. This
   * asserts the window's `end` is exactly the local scheduled hour with zero
   * minutes, which only holds when truncation happens in the zone's own
   * reported minutes/seconds, not in epoch space.
   */
  it('truncates to the top of the scheduled hour in the zone, even with a half-hour offset', () => {
    const now = new Date('2026-10-07T09:17:00+05:30'); // Kolkata, after the 08:00 hour
    const window = dueWindow(daily, 'daily', null, now, 'Asia/Kolkata');
    expect(window).not.toBeNull();
    expect(window?.end.toISOString()).toBe(new Date('2026-10-07T08:00:00+05:30').toISOString());
  });
});
