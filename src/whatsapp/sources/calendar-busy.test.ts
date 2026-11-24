import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CALENDAR_SYSTEM } from '../../calendar/calendar.js';
import type { CalendarClient, CalendarEvent } from '../../calendar/types.js';
import { closePool, withBusiness } from '../../db/pool.js';
import { upsertBinding } from '../../orchestrator/bindings.js';
import { resetDatabase, TEST_BUSINESS, testDb } from '../../test/db.js';
import { createCalendarBusySource } from './calendar-busy.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

const runtime = { credentials: { resolve: async () => ({ value: 'tok' }) } } as never;
const FROM = new Date('2026-12-01T09:00:00Z');
const TO = new Date('2026-12-01T10:00:00Z');
const ctx = (window: { from: Date; to: Date } | null) => ({ window, timeZone: 'Asia/Jerusalem' });
const ids = { key: '972501110001', email: null, subjectKey: '+972501110001' };

const event = (eventId: string, title: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  calendarId: 'a', eventId, title, start: '2026-12-01T09:30:00Z', end: '2026-12-01T10:30:00Z', allDay: false,
  location: null, description: null, organizerIsSelf: true, busy: true, selfDeclined: false, transactionId: null,
  attendees: [], ...over,
});

function fake(events: CalendarEvent[], truncated = false) {
  const calls = { n: 0 };
  const client = {
    listCalendars: async () => {
      calls.n += 1;
      return [{ calendarId: 'a', name: 'a', primary: true, canWrite: true }];
    },
    listEvents: async () => ({ events, truncated }),
  } as unknown as CalendarClient;
  return { client, calls };
}

async function connect() {
  await withBusiness(TEST_BUSINESS, (db) =>
    upsertBinding(db, {
      system: CALENDAR_SYSTEM, status: 'live', endpoint: null, credentialRef: 'OAUTH_CALENDAR',
      provider: 'google', lastOkAt: null, lastError: null,
    }, { by: 'test' }),
  );
}

const run = (client: CalendarClient, window: { from: Date; to: Date } | null) =>
  withBusiness(TEST_BUSINESS, (db) =>
    createCalendarBusySource({ runtime, client })(db, ids, new AbortController().signal, ctx(window)),
  );

describe('calendar busy source', () => {
  it('does nothing and calls no client without a window', async () => {
    await connect();
    const f = fake([]);
    const out = await run(f.client, null);
    expect(out).toEqual({ items: [], ownershipViolation: false });
    expect(f.calls.n).toBe(0);
  });

  it('says busy without the title of an unlinked event', async () => {
    await connect();
    const out = await run(fake([event('e1', 'דנה כהן')]).client, { from: FROM, to: TO });
    expect(out.items[0]?.label).toBe('יומן');
    expect(out.items[0]?.text).toContain('תפוס');
    expect(out.items[0]?.text).not.toContain('דנה');
  });

  it('says free when nothing overlaps', async () => {
    await connect();
    const out = await run(fake([event('e1', 'x', { start: '2026-12-01T12:00:00Z', end: '2026-12-01T13:00:00Z' })]).client, { from: FROM, to: TO });
    expect(out.items[0]?.text).toContain('פנוי');
  });

  it("shows the title of an event linked to this sender's meeting", async () => {
    await connect();
    await testDb().query(
      `INSERT INTO meetings (meeting_id, business_id, job_id, step_id, calendar_id, event_id, operation, client_name, client_phone)
       VALUES ('M1',$1,'j','s','a','e1','create','דנה','+972 50-111-0001')`,
      [TEST_BUSINESS],
    );
    const out = await run(fake([event('e1', 'פגישה‮ עם דנה')]).client, { from: FROM, to: TO });
    expect(out.items[0]?.text).toContain('תפוס');
    expect(out.items[0]?.text).toContain('— פגישה עם דנה');
  });

  it('fails (never free) when truncated', async () => {
    await connect();
    const out = await run(fake([], true).client, { from: FROM, to: TO });
    expect(out).toEqual({ items: [], ownershipViolation: false, failed: true });
  });

  it('fails when the calendar is not connected', async () => {
    const f = fake([]);
    const out = await run(f.client, { from: FROM, to: TO });
    expect(out.failed).toBe(true);
    expect(f.calls.n).toBe(0);
  });

  it('does not run on a window longer than two weeks', async () => {
    await connect();
    const f = fake([]);
    const out = await run(f.client, { from: FROM, to: new Date(FROM.getTime() + 21 * 86400_000) });
    expect(out.failed).toBe(true);
    expect(f.calls.n).toBe(0);
  });
});
