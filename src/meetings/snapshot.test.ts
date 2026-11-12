import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CalendarAccess } from '../calendar/client-for.js';
import type { CalendarClient, CalendarEvent, CalendarInfo } from '../calendar/types.js';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, TEST_BUSINESS, testDb } from '../test/db.js';
import { busyIntervals } from './free-time.js';
import { MEETING_DEFAULTS } from './settings.js';
import { loadCalendarRange, SNAPSHOT_MAX_EVENTS } from './snapshot.js';

const BUSINESS = 'test-business';
beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

const cal = (id: string): CalendarInfo => ({ calendarId: id, name: id, primary: id === 'a', canWrite: true });
const event = (calendarId: string, eventId: string, start: string, end: string): CalendarEvent => ({
  calendarId, eventId, title: 't', start, end, allDay: false, location: null, description: null,
  organizerIsSelf: true, busy: true, selfDeclined: false, transactionId: null, attendees: [],
});

function access(calendars: CalendarInfo[], byCal: Record<string, CalendarEvent[]>, seen: string[] = []): CalendarAccess {
  const client = {
    listCalendars: async () => calendars,
    listEvents: async (_t: string, q: { calendarId: string; maxEvents: number }) => {
      seen.push(`${q.calendarId}:${q.maxEvents}`);
      return { events: byCal[q.calendarId] ?? [], truncated: q.calendarId === 'b' };
    },
  } as unknown as CalendarClient;
  return { client, token: 't', provider: 'google' };
}
const base = {
  businessId: BUSINESS, timeZone: 'Asia/Jerusalem',
  fromIso: '2026-11-10T00:00:00Z', toIso: '2026-11-11T00:00:00Z', signal: new AbortController().signal,
};
const settings = (ids: string[]) => ({ ...MEETING_DEFAULTS, readCalendarIds: ids });

describe('loadCalendarRange', () => {
  it('reads every calendar when the read set is empty, ORs truncation, shrinks the budget', async () => {
    const seen: string[] = [];
    const a = access([cal('a'), cal('b')], { a: [event('a', 'x', '2026-11-10T08:00:00Z', '2026-11-10T09:00:00Z')], b: [] }, seen);
    const r = await withBusiness(TEST_BUSINESS, (db) => loadCalendarRange(db, { ...base, access: a, settings: settings([]) }));
    if ('failure' in r) throw new Error('unexpected');
    expect(seen).toEqual([`a:${SNAPSHOT_MAX_EVENTS}`, `b:${SNAPSHOT_MAX_EVENTS - 1}`]);
    expect(r.truncated).toBe(true);
  });

  it('reads only chosen calendars and skips an id no longer in the account', async () => {
    const seen: string[] = [];
    const r = await withBusiness(TEST_BUSINESS, (db) => loadCalendarRange(db, { ...base, access: access([cal('a'), cal('b')], {}, seen), settings: settings(['b', 'gone']) }));
    if ('failure' in r) throw new Error('unexpected');
    expect(seen).toHaveLength(1);
    expect(r.calendars.map((c) => c.calendarId)).toEqual(['b']);
  });

  it('returns a provider failure instead of a partial snapshot', async () => {
    const client = {
      listCalendars: async () => [cal('a')],
      listEvents: async () => ({ failure: 'auth', status: 401, message: 'no' }),
    } as unknown as CalendarClient;
    const r = await withBusiness(TEST_BUSINESS, (db) => loadCalendarRange(db, { ...base, access: { client, token: 't', provider: 'google' }, settings: settings([]) }));
    expect(r).toMatchObject({ failure: 'auth' });
  });

  it('counts held placeholders as busy', async () => {
    await testDb().query(
      `INSERT INTO meeting_holds (hold_id, business_id, job_id, calendar_id, event_id, start_at, end_at, state)
       VALUES ('h1',$1,'j','a','ev-h','2026-11-10T08:00:00Z','2026-11-10T09:00:00Z','held'),
              ('h2',$1,'j','a','ev-r','2026-11-10T10:00:00Z','2026-11-10T11:00:00Z','released')`,
      [BUSINESS],
    );
    const r = await withBusiness(TEST_BUSINESS, (db) => loadCalendarRange(db, { ...base, access: access([cal('a')], {}), settings: settings([]) }));
    if ('failure' in r) throw new Error('unexpected');
    expect(r.holds).toEqual([{ start: '2026-11-10T08:00:00.000Z', end: '2026-11-10T09:00:00.000Z', eventId: 'ev-h' }]);
    expect(busyIntervals(r, 0)).toEqual([{ start: Date.parse('2026-11-10T08:00:00Z'), end: Date.parse('2026-11-10T09:00:00Z') }]);
  });
});
