import { describe, expect, it } from 'vitest';
import type { CalendarClient, CalendarEvent, CalendarFailure } from '../../calendar/types.js';
import { HOLD_TITLE_PREFIX } from '../../calendar/calendar.js';
import { googleEventId } from '../../calendar/providers/google.js';
import { graphTransactionId } from '../../calendar/providers/graph.js';
import { createCalendarAdapter } from './calendar.js';
import { createCredentialHandle } from './types.js';
import type { AdapterCall } from './types.js';

const CAL = 'cal-1';
const START = '2026-11-10T09:00:00+02:00';
const END = '2026-11-10T10:00:00+02:00';

function ev(over: Partial<CalendarEvent>): CalendarEvent {
  return {
    calendarId: CAL,
    eventId: 'e1',
    title: 't',
    start: START,
    end: END,
    allDay: false,
    location: null,
    description: null,
    organizerIsSelf: true,
    busy: true,
    selfDeclined: false,
    transactionId: null,
    attendees: [],
    ...over,
  };
}

interface Rec {
  calls: { op: string; args: unknown[] }[];
}

function fakeClient(opts: {
  events?: CalendarEvent[];
  truncated?: boolean;
  list?: CalendarFailure;
  write?: CalendarFailure;
  throwOnWrite?: boolean;
  got?: CalendarEvent | CalendarFailure;
}): { client: CalendarClient; rec: Rec } {
  const rec: Rec = { calls: [] };
  const writeResult = (op: string, args: unknown[], id: string) => {
    rec.calls.push({ op, args });
    if (opts.throwOnWrite) throw new Error('socket hang up');
    return opts.write ?? { eventId: id };
  };
  const client: CalendarClient = {
    async listCalendars() {
      return [];
    },
    async listEvents(...args) {
      rec.calls.push({ op: 'list', args });
      if (opts.list) return opts.list;
      return { events: opts.events ?? [], truncated: opts.truncated ?? false };
    },
    async getEvent(...args) {
      rec.calls.push({ op: 'get', args });
      return opts.got ?? ev({ title: `${HOLD_TITLE_PREFIX}x` });
    },
    async createEvent(...args) {
      return writeResult('create', args, 'new-1');
    },
    async updateEvent(...args) {
      return writeResult('update', args, String(args[2]));
    },
    async deleteEvent(...args) {
      return writeResult('delete', args, String(args[2]));
    },
  };
  return { client, rec };
}

function call(toolName: string, input: unknown, key = 'idem-1'): AdapterCall {
  return {
    toolName,
    input,
    credential: createCredentialHandle('REF', 'tok'),
    endpoint: null,
    businessId: 'b',
    idempotencyKey: key,
    attachments: [],
    signal: new AbortController().signal,
  };
}

function adapter(client: CalendarClient) {
  return createCalendarAdapter({ system: 'calendar', provider: 'google', timeZone: async () => 'Asia/Jerusalem', client });
}

const create = (over: Record<string, unknown> = {}) => ({
  operation: 'create',
  calendarId: CAL,
  holdEventId: null,
  title: 'פגישה',
  start: START,
  end: END,
  location: null,
  description: null,
  attendees: ['a@b.co'],
  ...over,
});
const move = (over: Record<string, unknown> = {}) => ({
  operation: 'move',
  calendarId: CAL,
  eventId: 'e1',
  start: START,
  end: END,
  ...over,
});

describe('calendar adapter', () => {
  it('reads events in the window', async () => {
    const { client } = fakeClient({ events: [ev({})] });
    const r = await adapter(client).execute(call('calendar.read', { calendarId: CAL, fromIso: START, toIso: END }));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.output as { events: unknown[] }).events).toHaveLength(1);
  });

  it('retries a 401 on a read', async () => {
    const { client } = fakeClient({ list: { failure: 'auth', status: 401, message: 'x' } });
    const r = await adapter(client).execute(call('calendar.read', { calendarId: CAL, fromIso: START, toIso: END }));
    expect(r).toMatchObject({ ok: false, retryable: true, code: 'calendar_auth' });
  });

  it('refuses a create or move whose interval became busy, with slot_taken', async () => {
    const { client, rec } = fakeClient({ events: [ev({ eventId: 'other' })] });
    const a = adapter(client);
    for (const input of [create(), move()]) {
      const r = await a.execute(call('calendar.write', input));
      expect(r).toMatchObject({ ok: false, retryable: false, code: 'slot_taken', message: 'המועד נתפס בינתיים — לא נכתב דבר' });
    }
    expect(rec.calls.some((c) => c.op !== 'list')).toBe(false);
  });

  it('ignores the moved event itself in the re-check', async () => {
    const { client, rec } = fakeClient({ events: [ev({ eventId: 'e1' })] });
    const r = await adapter(client).execute(call('calendar.write', move()));
    expect(r).toMatchObject({ ok: true, externalId: 'e1' });
    expect(rec.calls.map((c) => c.op)).toEqual(['list', 'update']);
  });

  it('does not treat free, declined or non-overlapping events as busy', async () => {
    const { client } = fakeClient({
      events: [
        ev({ eventId: 'f', busy: false }),
        ev({ eventId: 'd', selfDeclined: true }),
        ev({ eventId: 'adj', start: END, end: '2026-11-10T11:00:00+02:00' }),
      ],
    });
    const r = await adapter(client).execute(call('calendar.write', create()));
    expect(r.ok).toBe(true);
  });

  it('refuses when the re-check list is truncated', async () => {
    const { client } = fakeClient({ truncated: true });
    const r = await adapter(client).execute(call('calendar.write', create()));
    expect(r).toMatchObject({ ok: false, code: 'recheck_incomplete' });
  });

  it('converts a hold by id instead of creating a second event', async () => {
    const { client, rec } = fakeClient({ events: [ev({ eventId: 'hold-1' })] });
    const r = await adapter(client).execute(call('calendar.write', create({ holdEventId: 'hold-1' })));
    expect(r).toMatchObject({ ok: true, externalId: 'hold-1' });
    expect(rec.calls.map((c) => c.op)).toEqual(['get', 'list', 'update']);
    expect(rec.calls.some((c) => c.op === 'create')).toBe(false);
  });

  it('creates with the call idempotency key when there is no hold', async () => {
    const { client, rec } = fakeClient({});
    const r = await adapter(client).execute(call('calendar.write', create(), 'key-42'));
    expect(r).toMatchObject({ ok: true, externalId: 'new-1' });
    const c = rec.calls.find((x) => x.op === 'create');
    expect(c?.args[3]).toBe('key-42');
  });

  it('does not mark a 401 on a write retryable', async () => {
    const { client } = fakeClient({ write: { failure: 'auth', status: 401, message: 'secret detail' } });
    const r = await adapter(client).execute(call('calendar.write', { operation: 'cancel', calendarId: CAL, eventId: 'e1' }));
    expect(r).toMatchObject({ ok: false, retryable: false, code: 'calendar_auth' });
    expect(JSON.stringify(r)).not.toContain('secret detail');
  });

  it('marks a thrown write delivery_unknown and not retryable', async () => {
    const { client } = fakeClient({ throwOnWrite: true });
    const r = await adapter(client).execute(call('calendar.write', create()));
    expect(r).toMatchObject({ ok: false, retryable: false, code: 'calendar_delivery_unknown' });
  });

  it('retries a write only when the provider answered 5xx/429', async () => {
    const a5 = adapter(fakeClient({ write: { failure: 'transient', status: 503, message: '' } }).client);
    expect(await a5.execute(call('calendar.write', create()))).toMatchObject({ retryable: true, code: 'calendar_unavailable' });
    const a0 = adapter(fakeClient({ write: { failure: 'transient', status: 0, message: '' } }).client);
    expect(await a0.execute(call('calendar.write', create()))).toMatchObject({ retryable: false, code: 'calendar_delivery_unknown' });
  });

  it('maps not_found and rejected', async () => {
    const nf = adapter(fakeClient({ write: { failure: 'not_found', status: 404, message: '' } }).client);
    expect(await nf.execute(call('calendar.write', { operation: 'update', calendarId: CAL, eventId: 'x', location: 'a' }))).toMatchObject({
      code: 'event_not_found',
    });
    const rj = adapter(fakeClient({ write: { failure: 'rejected', status: 400, message: '' } }).client);
    expect(await rj.execute(call('calendar.write', create()))).toMatchObject({ code: 'calendar_rejected' });
  });

  it('aborts the write when the re-check read fails', async () => {
    const { client, rec } = fakeClient({ list: { failure: 'auth', status: 401, message: '' } });
    const r = await adapter(client).execute(call('calendar.write', create()));
    expect(r).toMatchObject({ ok: false, retryable: false, code: 'calendar_auth' });
    expect(rec.calls.map((c) => c.op)).toEqual(['list']);
  });

  it('patches only the fields an update names', async () => {
    const { client, rec } = fakeClient({});
    await adapter(client).execute(call('calendar.write', { operation: 'update', calendarId: CAL, eventId: 'e1', location: 'חיפה' }));
    expect(rec.calls[0]?.args[3]).toEqual({ location: 'חיפה' });
  });

  it('refuses to convert an event that is not a real hold', async () => {
    const bad = [
      ev({ title: 'פגישה עם לקוח', attendees: [] }),
      ev({ title: `${HOLD_TITLE_PREFIX}x`, attendees: [{ email: 'a@b.co', response: 'accepted' }] }),
      ev({ title: `${HOLD_TITLE_PREFIX}x`, organizerIsSelf: false }),
    ];
    for (const got of bad) {
      const { client, rec } = fakeClient({ got });
      const r = await adapter(client).execute(call('calendar.write', create({ holdEventId: 'e1' })));
      expect(r).toMatchObject({ ok: false, retryable: false, code: 'not_a_hold', message: 'האירוע שצוין אינו שמירת מקום של העוזרת — לא נכתב דבר' });
      expect(rec.calls.some((c) => c.op === 'update' || c.op === 'create')).toBe(false);
    }
  });

  it('lets a retried create ignore its own event (Google key-derived id)', async () => {
    const { client, rec } = fakeClient({ events: [ev({ eventId: googleEventId('idem-1') })] });
    const r = await adapter(client).execute(call('calendar.write', create()));
    expect(r.ok).toBe(true);
    expect(rec.calls.map((c) => c.op)).toEqual(['list', 'create']);
  });

  it('lets a retried create ignore its own event (Graph transactionId)', async () => {
    const { client } = fakeClient({ events: [ev({ eventId: 'g1', transactionId: graphTransactionId('idem-1') })] });
    const a = createCalendarAdapter({ system: 'calendar', provider: 'microsoft', timeZone: async () => 'Asia/Jerusalem', client });
    expect((await a.execute(call('calendar.write', create()))).ok).toBe(true);
    const other = fakeClient({ events: [ev({ eventId: 'g2', transactionId: graphTransactionId('different') })] }).client;
    const b = createCalendarAdapter({ system: 'calendar', provider: 'microsoft', timeZone: async () => 'Asia/Jerusalem', client: other });
    expect(await b.execute(call('calendar.write', create()))).toMatchObject({ code: 'slot_taken' });
  });

  it('does not retry a 403 on a read', async () => {
    const { client } = fakeClient({ list: { failure: 'auth', status: 403, message: 'x' } });
    const r = await adapter(client).execute(call('calendar.read', { calendarId: CAL, fromIso: START, toIso: END }));
    expect(r).toMatchObject({ ok: false, retryable: false, code: 'calendar_auth' });
  });

  it('treats a cancel of an already-deleted event as success', async () => {
    const { client } = fakeClient({ write: { failure: 'not_found', status: 404, message: '' } });
    const r = await adapter(client).execute(call('calendar.write', { operation: 'cancel', calendarId: CAL, eventId: 'gone' }));
    expect(r).toMatchObject({ ok: true, externalId: 'gone' });
  });

  it('uses recheck_incomplete when the re-check list fails non-auth', async () => {
    const { client } = fakeClient({ list: { failure: 'rejected', status: 400, message: '' } });
    expect(await adapter(client).execute(call('calendar.write', create()))).toMatchObject({ code: 'recheck_incomplete', retryable: false });
  });

  it('enforces length caps', async () => {
    const { client } = fakeClient({});
    const a = adapter(client);
    expect(await a.execute(call('calendar.write', create({ title: 'x'.repeat(301) })))).toMatchObject({ code: 'invalid_input' });
    expect(await a.execute(call('calendar.write', create({ attendees: Array.from({ length: 51 }, (_, i) => `a${i}@b.co`) })))).toMatchObject({ code: 'invalid_input' });
  });

  it('refuses a payload with an unknown field', async () => {
    const { client, rec } = fakeClient({});
    const r = await adapter(client).execute(call('calendar.write', create({ sneaky: 1 })));
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(rec.calls).toHaveLength(0);
  });

  it('refuses an instant without an offset and an inverted interval', async () => {
    const { client } = fakeClient({});
    const a = adapter(client);
    expect(await a.execute(call('calendar.write', create({ start: '2026-11-10T09:00:00' })))).toMatchObject({ code: 'invalid_input' });
    expect(await a.execute(call('calendar.write', create({ start: END, end: START })))).toMatchObject({ code: 'invalid_input' });
  });

  it('refuses a foreign tool, an aborted signal and a missing credential', async () => {
    const { client } = fakeClient({});
    const a = adapter(client);
    expect(await a.execute(call('mail.send', {}))).toMatchObject({ code: 'unsupported_tool' });
    const ac = new AbortController();
    ac.abort();
    expect(await a.execute({ ...call('calendar.write', create()), signal: ac.signal })).toMatchObject({ code: 'aborted' });
    expect(await a.execute({ ...call('calendar.write', create()), credential: null })).toMatchObject({ code: 'credential_unavailable' });
  });
});
