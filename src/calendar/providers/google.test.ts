import { describe, expect, it } from 'vitest';
import { createGoogleCalendarClient, googleEventId } from './google.js';
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
  calendarId: 'primary',
  fromIso: '2026-11-01T00:00:00Z',
  toIso: '2026-12-01T00:00:00Z',
  timeZone: 'Asia/Jerusalem',
  maxEvents: 50,
};
const timed = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  summary: 'meeting',
  start: { dateTime: '2026-11-10T09:00:00+02:00' },
  end: { dateTime: '2026-11-10T10:00:00+02:00' },
  ...extra,
});
const WRITE = {
  title: 't',
  start: '2026-11-10T07:00:00.000Z',
  end: '2026-11-10T08:00:00.000Z',
  location: null,
  description: null,
  attendees: ['a@b.co'],
};

describe('google calendar client', () => {
  it('lists recurring events as single occurrences with their own ids', async () => {
    const { http, calls } = fake(() => ({ status: 200, body: { items: [timed('rec_20261110'), timed('rec_20261117')] } }));
    const r = await createGoogleCalendarClient(http).listEvents('tok', Q, signal);
    if ('failure' in r) throw new Error('unexpected');
    expect(calls[0]!.url).toContain('singleEvents=true');
    expect(calls[0]!.url).toContain('orderBy=startTime');
    expect(r.events.map((e) => e.eventId)).toEqual(['rec_20261110', 'rec_20261117']);
    expect(r.events[0]!.start).toBe('2026-11-10T07:00:00.000Z');
  });

  it('follows pagination until maxEvents and marks truncated', async () => {
    let page = 0;
    const { http, calls } = fake(() => {
      page += 1;
      return { status: 200, body: { items: [timed(`p${page}a`), timed(`p${page}b`)], nextPageToken: `t${page}` } };
    });
    const r = await createGoogleCalendarClient(http).listEvents('tok', { ...Q, maxEvents: 5 }, signal);
    if ('failure' in r) throw new Error('unexpected');
    expect(r.events).toHaveLength(5);
    expect(r.truncated).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toContain('pageToken=t1');
  });

  it('is not truncated when the last page ends exactly at maxEvents', async () => {
    const { http } = fake(() => ({ status: 200, body: { items: [timed('a'), timed('b')] } }));
    const r = await createGoogleCalendarClient(http).listEvents('tok', { ...Q, maxEvents: 2 }, signal);
    if ('failure' in r) throw new Error('unexpected');
    expect(r.truncated).toBe(false);
  });

  it('marks transparent events as not busy and events the owner declined as selfDeclined', async () => {
    const { http } = fake(() => ({
      status: 200,
      body: {
        items: [
          timed('free', { transparency: 'transparent' }),
          timed('busy'),
          timed('declined', {
            attendees: [
              { email: 'me@b.co', self: true, responseStatus: 'declined' },
              { email: 'x@y.co', responseStatus: 'accepted' },
            ],
          }),
        ],
      },
    }));
    const r = await createGoogleCalendarClient(http).listEvents('tok', Q, signal);
    if ('failure' in r) throw new Error('unexpected');
    const by = Object.fromEntries(r.events.map((e) => [e.eventId, e]));
    expect(by['free']!.busy).toBe(false);
    expect(by['busy']!.busy).toBe(true);
    expect(by['busy']!.selfDeclined).toBe(false);
    expect(by['declined']!.selfDeclined).toBe(true);
    expect(by['declined']!.attendees).toEqual([{ email: 'x@y.co', response: 'accepted' }]);
  });

  it('drops the owner’s own attendee entry, even when Google lists him first', async () => {
    const { http } = fake(() => ({
      status: 200,
      body: {
        items: [
          timed('guests', {
            organizer: { email: 'me@b.co', self: true },
            attendees: [
              { email: 'me@b.co', self: true, organizer: true, responseStatus: 'accepted' },
              { email: 'dana@client.co', responseStatus: 'declined' },
            ],
          }),
        ],
      },
    }));
    const r = await createGoogleCalendarClient(http).listEvents('tok', Q, signal);
    if ('failure' in r) throw new Error('unexpected');
    expect(r.events[0]!.attendees).toEqual([{ email: 'dana@client.co', response: 'declined' }]);
    expect(r.events[0]!.organizerIsSelf).toBe(true);
    expect(r.events[0]!.selfDeclined).toBe(false);
  });

  it('maps all-day events to local-midnight instants in the given zone', async () => {
    const { http } = fake(() => ({
      status: 200,
      body: { items: [{ id: 'ad', summary: 'holiday', start: { date: '2026-11-12' }, end: { date: '2026-11-13' } }] },
    }));
    const r = await createGoogleCalendarClient(http).listEvents('tok', Q, signal);
    if ('failure' in r) throw new Error('unexpected');
    expect(r.events[0]).toMatchObject({
      allDay: true,
      start: '2026-11-11T22:00:00.000Z',
      end: '2026-11-12T22:00:00.000Z',
    });
  });

  it('derives a deterministic event id from the idempotency key and treats 409 as replay', async () => {
    const id = googleEventId('key-1');
    expect(id).toBe(googleEventId('key-1'));
    expect(id).not.toBe(googleEventId('key-2'));
    expect(id).toMatch(/^a[0-9a-v]{39}$/);
    const { http, calls } = fake(() => ({ status: 409, body: { error: { message: 'duplicate' } } }));
    const r = await createGoogleCalendarClient(http).createEvent('tok', 'primary', WRITE, 'key-1', signal);
    expect(r).toEqual({ eventId: id });
    expect(calls[0]!.url).toContain('sendUpdates=all');
    expect((calls[0]!.body as { id: string }).id).toBe(id);
  });

  it('sends updates on update and delete', async () => {
    const { http, calls } = fake(() => ({ status: 200, body: { id: 'e1' } }));
    const c = createGoogleCalendarClient(http);
    await c.updateEvent('tok', 'primary', 'e1', { title: 'x' }, signal);
    await c.deleteEvent('tok', 'primary', 'e1', signal);
    expect(calls.map((x) => [x.method, x.url.includes('sendUpdates=all')])).toEqual([
      ['PATCH', true],
      ['DELETE', true],
    ]);
    expect(calls[0]!.body).toEqual({ summary: 'x' });
  });

  it('maps 401 to auth, 404 to not_found, 503 to transient, 400 to rejected', async () => {
    for (const [status, failure] of [
      [401, 'auth'],
      [404, 'not_found'],
      [503, 'transient'],
      [400, 'rejected'],
    ] as const) {
      const { http } = fake(() => ({ status, body: null }));
      const r = await createGoogleCalendarClient(http).getEvent('tok', 'primary', 'e', 'UTC', signal);
      expect(r).toMatchObject({ failure, status });
    }
  });

  it('turns a throwing transport into a transient failure', async () => {
    const http: CalendarHttp = { request: () => Promise.reject(new Error('boom')) };
    expect(await createGoogleCalendarClient(http).listCalendars('tok', signal)).toMatchObject({ failure: 'transient' });
  });

  it('turns an HTML description into plain text', async () => {
    const { http } = fake(() => ({
      status: 200,
      body: {
        items: [timed('d', { description: 'Hello&nbsp;<b>there</b><br>see <a href="x">link</a> &lt;ok&gt; &quot;q&quot; it&#39;s<br/>' })],
      },
    }));
    const r = await createGoogleCalendarClient(http).listEvents('tok', Q, signal);
    if ('failure' in r) throw new Error('unexpected');
    expect(r.events[0]!.description).toBe("Hello there\nsee link <ok> \"q\" it's");
  });
});
