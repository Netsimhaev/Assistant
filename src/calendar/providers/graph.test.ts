import { describe, expect, it } from 'vitest';
import { createGraphCalendarClient } from './graph.js';
import type { CalendarHttp } from '../types.js';

type Req = Parameters<CalendarHttp['request']>[0];

function fake(handler: (r: Req) => { status: number; body: unknown }): { http: CalendarHttp; calls: Req[] } {
  const calls: Req[] = [];
  return {
    calls,
    http: {
      async request(r) {
        calls.push(r);
        return handler(r);
      },
    },
  };
}

const signal = new AbortController().signal;
const Q = {
  calendarId: 'cal1',
  fromIso: '2026-11-01T00:00:00Z',
  toIso: '2026-12-01T00:00:00Z',
  timeZone: 'Asia/Jerusalem',
  maxEvents: 50,
};
const ev = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  subject: 'meeting',
  start: { dateTime: '2026-11-10T09:00:00.0000000', timeZone: 'Asia/Jerusalem' },
  end: { dateTime: '2026-11-10T10:00:00.0000000', timeZone: 'Asia/Jerusalem' },
  isAllDay: false,
  showAs: 'busy',
  ...extra,
});
const WRITE = {
  title: 't',
  start: '2026-11-10T07:00:00.000Z',
  end: '2026-11-10T08:00:00.000Z',
  location: 'x',
  description: 'd',
  attendees: ['a@b.co'],
};

describe('graph calendar client', () => {
  it('lists calendars', async () => {
    const { http, calls } = fake(() => ({
      status: 200,
      body: { value: [{ id: 'c1', name: 'Calendar', isDefaultCalendar: true, canEdit: true }] },
    }));
    const r = await createGraphCalendarClient(http).listCalendars('tok', signal);
    expect(calls[0]!.url).toContain('/me/calendars');
    expect(r).toEqual([{ calendarId: 'c1', name: 'Calendar', primary: true, canWrite: true }]);
  });

  it('reads calendarView in the given zone as separate occurrences', async () => {
    const { http, calls } = fake(() => ({ status: 200, body: { value: [ev('occ1'), ev('occ2')] } }));
    const r = await createGraphCalendarClient(http).listEvents('tok', Q, signal);
    if ('failure' in r) throw new Error('unexpected');
    expect(calls[0]!.url).toContain('/me/calendars/cal1/calendarView?');
    expect(calls[0]!.url).toContain('startDateTime=');
    expect(calls[0]!.headers).toEqual({ Prefer: 'outlook.timezone="Asia/Jerusalem", outlook.body-content-type="text"' });
    expect(r.events.map((e) => e.eventId)).toEqual(['occ1', 'occ2']);
    expect(r.events[0]!.start).toBe('2026-11-10T07:00:00.000Z');
  });

  it('follows pagination until maxEvents and marks truncated', async () => {
    let page = 0;
    const { http, calls } = fake(() => {
      page += 1;
      return {
        status: 200,
        body: { value: [ev(`p${page}a`), ev(`p${page}b`)], '@odata.nextLink': `https://graph.microsoft.com/next${page}` },
      };
    });
    const r = await createGraphCalendarClient(http).listEvents('tok', { ...Q, maxEvents: 5 }, signal);
    if ('failure' in r) throw new Error('unexpected');
    expect(r.events).toHaveLength(5);
    expect(r.truncated).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toBe('https://graph.microsoft.com/next1');
  });

  it('marks showAs free events as not busy and events the owner declined as selfDeclined', async () => {
    const { http } = fake(() => ({
      status: 200,
      body: { value: [ev('free', { showAs: 'free' }), ev('busy'), ev('dec', { responseStatus: { response: 'declined' } })] },
    }));
    const r = await createGraphCalendarClient(http).listEvents('tok', Q, signal);
    if ('failure' in r) throw new Error('unexpected');
    const by = Object.fromEntries(r.events.map((e) => [e.eventId, e]));
    expect(by['free']!.busy).toBe(false);
    expect(by['busy']!.busy).toBe(true);
    expect(by['dec']!.selfDeclined).toBe(true);
    expect(by['busy']!.selfDeclined).toBe(false);
  });

  it('maps all-day events to local-midnight instants in the given zone', async () => {
    const { http } = fake(() => ({
      status: 200,
      body: {
        value: [
          ev('ad', {
            isAllDay: true,
            start: { dateTime: '2026-11-12T00:00:00.0000000', timeZone: 'Asia/Jerusalem' },
            end: { dateTime: '2026-11-13T00:00:00.0000000', timeZone: 'Asia/Jerusalem' },
          }),
        ],
      },
    }));
    const r = await createGraphCalendarClient(http).listEvents('tok', Q, signal);
    if ('failure' in r) throw new Error('unexpected');
    expect(r.events[0]).toMatchObject({ allDay: true, start: '2026-11-11T22:00:00.000Z' });
  });

  it('sends the idempotency key as transactionId', async () => {
    const { http, calls } = fake(() => ({ status: 201, body: { id: 'new1' } }));
    const c = createGraphCalendarClient(http);
    const r = await c.createEvent('tok', 'cal1', WRITE, 'key-1', signal);
    await c.createEvent('tok', 'cal1', WRITE, 'key-2', signal);
    expect(r).toEqual({ eventId: 'new1' });
    const t1 = (calls[0]!.body as { transactionId: string }).transactionId;
    const t2 = (calls[1]!.body as { transactionId: string }).transactionId;
    expect(t1).toMatch(/^[0-9a-f]{36}$/);
    expect(t1).not.toBe(t2);
  });

  it('sends start and end converted to UTC, whatever offset the write carried', async () => {
    const { http, calls } = fake(() => ({ status: 201, body: { id: 'new1' } }));
    const c = createGraphCalendarClient(http);
    await c.createEvent(
      'tok',
      'cal1',
      { ...WRITE, start: '2026-11-10T09:00:00+02:00', end: '2026-11-10T10:00:00.000Z' },
      'key-utc',
      signal,
    );
    const body = calls[0]!.body as { start: unknown; end: unknown };
    expect(body.start).toEqual({ dateTime: '2026-11-10T07:00:00.000', timeZone: 'UTC' });
    expect(body.end).toEqual({ dateTime: '2026-11-10T10:00:00.000', timeZone: 'UTC' });
  });

  it('maps 401 to auth, 404 to not_found, 503 to transient, 400 to rejected', async () => {
    for (const [status, failure] of [
      [401, 'auth'],
      [404, 'not_found'],
      [503, 'transient'],
      [400, 'rejected'],
    ] as const) {
      const { http } = fake(() => ({ status, body: { error: { message: 'x' } } }));
      const r = await createGraphCalendarClient(http).deleteEvent('tok', 'cal1', 'e', signal);
      expect(r).toMatchObject({ failure, status });
    }
  });

  it('strips HTML from the description defensively', async () => {
    const { http } = fake(() => ({
      status: 200,
      body: { value: [ev('h', { body: { contentType: 'text', content: '<html><p>Line one</p>Tom &amp; Jerry<br>two</html>' } })] },
    }));
    const r = await createGraphCalendarClient(http).listEvents('tok', Q, signal);
    if ('failure' in r) throw new Error('unexpected');
    expect(r.events[0]!.description).toBe('Line one\nTom & Jerry\ntwo');
  });

  it('falls back to the requested zone when the returned zone cannot be resolved', async () => {
    const { http } = fake(() => ({
      status: 200,
      body: { value: [ev('z', { start: { dateTime: '2026-11-10T09:00:00.0000000', timeZone: 'Customized Time Zone' } })] },
    }));
    const r = await createGraphCalendarClient(http).listEvents('tok', Q, signal);
    if ('failure' in r) throw new Error('unexpected');
    expect(r.events[0]!.start).toBe('2026-11-10T07:00:00.000Z');
  });

  it('maps a non-2xx listEvents response to a failure', async () => {
    const { http } = fake(() => ({ status: 503, body: { error: { message: 'busy' } } }));
    expect(await createGraphCalendarClient(http).listEvents('tok', Q, signal)).toMatchObject({
      failure: 'transient',
      status: 503,
    });
  });
});
