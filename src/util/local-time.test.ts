import { describe, expect, it } from 'vitest';
import { addBusinessDays, localParts, localToInstant } from './local-time.js';

const TZ = 'Asia/Jerusalem';

describe('localToInstant', () => {
  it('resolves a winter time (UTC+2)', () => {
    expect(localToInstant('2026-11-01', '09:00', TZ).toISOString()).toBe('2026-11-01T07:00:00.000Z');
  });

  it('resolves a summer time (UTC+3)', () => {
    expect(localToInstant('2026-10-20', '09:00', TZ).toISOString()).toBe('2026-10-20T06:00:00.000Z');
  });

  it('round-trips an ambiguous night time on DST-end day to the same local date', () => {
    const at = localToInstant('2026-10-25', '01:30', TZ);
    expect(localParts(at, TZ).date).toBe('2026-10-25');
    expect(localParts(at, TZ).time).toBe('01:30');
  });

  it('resolves a nonexistent DST-gap time to the first valid minute after it', () => {
    // Israel springs forward 2026-03-27 at 02:00 -> 03:00.
    const at = localToInstant('2026-03-27', '02:30', TZ);
    expect(localParts(at, TZ)).toMatchObject({ date: '2026-03-27', time: '03:00' });
  });
});

describe('localParts', () => {
  it('reads an instant in the given zone', () => {
    expect(localParts(new Date('2026-10-31T22:30:00Z'), TZ)).toEqual({
      date: '2026-11-01',
      time: '00:30',
      weekday: 'sun',
    });
  });
});

describe('addBusinessDays', () => {
  const opts = { timeZone: TZ, workweek: ['sun', 'mon', 'tue', 'wed', 'thu'] as const, holidays: [] as string[], hour: 8 };

  it('skips the weekend: Thu + 1 business day is Sun at 08:00 local', () => {
    const from = localToInstant('2026-10-29', '15:00', TZ);
    const got = addBusinessDays(from, 1, { ...opts, workweek: [...opts.workweek] });
    expect(localParts(got, TZ)).toEqual({ date: '2026-11-01', time: '08:00', weekday: 'sun' });
  });

  it('skips a holiday on the target date', () => {
    const from = localToInstant('2026-10-29', '15:00', TZ);
    const got = addBusinessDays(from, 1, { ...opts, workweek: [...opts.workweek], holidays: ['2026-11-01'] });
    expect(localParts(got, TZ).date).toBe('2026-11-02');
  });
});
