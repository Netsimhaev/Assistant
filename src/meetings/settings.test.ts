import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { MEETING_DEFAULTS, loadMeetingSettings, saveMeetingSettings, type MeetingSettings } from './settings.js';

const BUSINESS = 'test-business';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

function valid(over: Partial<MeetingSettings> = {}): MeetingSettings {
  return { ...MEETING_DEFAULTS, readCalendarIds: [], locationKind: 'travel', ...over };
}

async function refused(over: Partial<MeetingSettings>): Promise<string> {
  const r = await saveMeetingSettings(valid(over), { businessId: BUSINESS });
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.reason;
}

describe('meeting settings', () => {
  it('loads defaults for a business without a row', async () => {
    const s = await loadMeetingSettings({ businessId: BUSINESS });
    expect(s).toEqual({ ...MEETING_DEFAULTS, readCalendarIds: [] });
    expect(s.locationKind).toBeNull();
  });

  it('saves and reloads, trimming the time to HH:MM', async () => {
    const r = await saveMeetingSettings(
      valid({
        locationKind: 'mixed',
        gapMinutes: 15,
        workStart: '08:30',
        workEnd: '17:00',
        readCalendarIds: ['a', 'b'],
        writeCalendarId: 'b',
      }),
      { businessId: BUSINESS },
    );
    expect(r).toEqual({ ok: true });
    const s = await loadMeetingSettings({ businessId: BUSINESS });
    expect(s).toMatchObject({
      locationKind: 'mixed',
      gapMinutes: 15,
      workStart: '08:30',
      workEnd: '17:00',
      readCalendarIds: ['a', 'b'],
      writeCalendarId: 'b',
    });
  });

  it('refuses fixed location without an address, in Hebrew', async () => {
    expect(await refused({ locationKind: 'fixed', fixedAddress: '  ' })).toContain('כתובת');
  });

  it('refuses a missing location kind', async () => {
    expect(await refused({ locationKind: null })).toContain('איפה');
  });

  it('refuses work_end before work_start, and a half-set window', async () => {
    expect(await refused({ workStart: '18:00', workEnd: '09:00' })).toContain('אחרי');
    expect(await refused({ workStart: '09:00', workEnd: null })).toContain('וגם');
  });

  it('refuses a write calendar not in the read set', async () => {
    expect(await refused({ readCalendarIds: ['a'], writeCalendarId: 'b' })).toContain('יומן הפגישות');
  });

  it('refuses gap and duration outside the ranges and non-positive reminders', async () => {
    await refused({ gapMinutes: 241 });
    await refused({ gapMinutes: -1 });
    await refused({ defaultDurationMinutes: 4 });
    await refused({ reminderHours: 0 });
    await refused({ reminderHoursSoon: -3 });
  });

  it('writes nothing when it refuses', async () => {
    await refused({ gapMinutes: 999 });
    expect((await loadMeetingSettings({ businessId: BUSINESS })).locationKind).toBeNull();
  });
});
