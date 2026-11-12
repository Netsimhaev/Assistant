import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
import { upsertBinding } from '../orchestrator/bindings.js';
import { createJob } from '../orchestrator/jobs.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { CALENDAR_SYSTEM, HOLD_TITLE_PREFIX } from '../calendar/calendar.js';
import type { CalendarAccess } from '../calendar/client-for.js';
import type { CalendarClient, CalendarEvent, EventWrite } from '../calendar/types.js';
import { createHold, markHoldConverted, releaseHold, sweepHolds } from './holds.js';

const BUSINESS = TEST_BUSINESS;
const SIGNAL = new AbortController().signal;

interface Call {
  op: string;
  args: unknown[];
}

function fake(
  opts: {
    deleteResult?: 'not_found' | 'transient';
    current?: Partial<CalendarEvent> | 'not_found';
    createdId?: string;
  } = {},
): { client: CalendarClient; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const unused = async (): Promise<never> => {
    throw new Error('holds must not call this');
  };
  const client: CalendarClient = {
    listCalendars: unused,
    listEvents: unused,
    async getEvent(...args) {
      calls.push({ op: 'get', args });
      if (opts.current === 'not_found') return { failure: 'not_found', status: 404, message: 'x' };
      return {
        calendarId: 'cal-1',
        eventId: String(args[2]),
        title: `${HOLD_TITLE_PREFIX}דנה`,
        start: '2026-11-10T08:00:00.000Z',
        end: '2026-11-10T09:00:00.000Z',
        allDay: false,
        location: null,
        description: null,
        organizerIsSelf: true,
        busy: true,
        selfDeclined: false,
        transactionId: null,
        attendees: [],
        ...(opts.current ?? {}),
      };
    },
    updateEvent: unused,
    async createEvent(...args) {
      calls.push({ op: 'create', args });
      n += 1;
      return { eventId: opts.createdId ?? `ev-${n}` };
    },
    async deleteEvent(...args) {
      calls.push({ op: 'delete', args });
      if (opts.deleteResult) {
        return { failure: opts.deleteResult, status: 0, message: 'x' };
      }
      return { eventId: String(args[2]) };
    },
  };
  return { client, calls };
}

function accessOf(client: CalendarClient): CalendarAccess {
  return { client, token: 'tok', provider: 'google' };
}

let charterVersion = '';

async function newJob(phase = 'plan'): Promise<string> {
  const job = await withBusiness(BUSINESS, (db) => createJob(db, { charterVersion, provenance: 'boss', title: 't' }));
  await testDb().query('UPDATE jobs SET phase = $1 WHERE job_id = $2', [phase, job.jobId]);
  return job.jobId;
}

async function hold(client: CalendarClient, jobId: string, name = 'דנה לוי') {
  const r = await withBusiness(BUSINESS, (db) => createHold(db, {
    access: accessOf(client),
    jobId,
    calendarId: 'cal-1',
    start: '2026-11-10T08:00:00.000Z',
    end: '2026-11-10T09:00:00.000Z',
    clientName: name,
    signal: SIGNAL,
  }));
  if ('failure' in r) throw new Error('hold failed');
  return r;
}

async function state(holdId: string): Promise<string> {
  const { rows } = await testDb().query<{ state: string }>('SELECT state FROM meeting_holds WHERE hold_id = $1', [holdId]);
  return rows[0]?.state ?? 'missing';
}

async function addConfirmation(jobId: string, st: string): Promise<void> {
  await testDb().query(
    `INSERT INTO instruction_confirmations (business_id, job_id, options, presented_text, channel, state, chosen_plan_hash)
     VALUES ($1, $2, '[]'::jsonb, 'q', 'whatsapp', $3, $4)`,
    [BUSINESS, jobId, st, st === 'confirmed' ? 'h' : null],
  );
}

const runtime = { credentials: { resolve: async () => ({ value: 'tok' }) } } as never;

beforeEach(async () => {
  await resetDatabase();
  charterVersion = (await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()))).charterVersion;
});
afterAll(async () => {
  await closePool();
});

describe('holds', () => {
  it('creates an attendee-less hold and records it without the client name in audit', async () => {
    const { client, calls } = fake();
    const jobId = await newJob();
    const h = await hold(client, jobId, 'דנה‮ לוי\nשורה');
    const write = calls[0]?.args[2] as EventWrite;
    expect(write.attendees).toEqual([]);
    expect(write.location).toBeNull();
    expect(write.description).toBe('שמירת מקום של העוזרת — ממתינה לאישור שלך.');
    expect(write.title.startsWith(HOLD_TITLE_PREFIX)).toBe(true);
    expect(write.title).not.toMatch(/[‮\n]/);
    expect(calls[0]?.args[3]).toBe(`hold:${h.holdId}`);
    expect(await state(h.holdId)).toBe('held');

    const { rows } = await testDb().query<Record<string, unknown>>(
      "SELECT * FROM audit_log WHERE reason = 'calendar_hold:created'",
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0], (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain('לוי');
    expect(JSON.stringify(rows[0], (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain('דנה');
  });

  it('release deletes only a hold it created', async () => {
    const { client, calls } = fake();
    const h = await hold(client, await newJob());
    const r = await withBusiness(BUSINESS, (db) => releaseHold(db, { access: accessOf(client), holdId: h.holdId, signal: SIGNAL }));
    expect(r).toBe('released');
    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(1);
    expect(calls.find((c) => c.op === 'delete')?.args[2]).toBe(h.eventId);
    expect(await state(h.holdId)).toBe('released');
    const again = await withBusiness(BUSINESS, (db) => releaseHold(db, { access: accessOf(client), holdId: h.holdId, signal: SIGNAL }));
    expect(again).toBe('already');
    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(1);
  });

  it('counts a provider not_found as released', async () => {
    const created = fake();
    const h = await hold(created.client, await newJob());
    const gone = fake({ deleteResult: 'not_found' });
    const r = await withBusiness(BUSINESS, (db) => releaseHold(db, { access: accessOf(gone.client), holdId: h.holdId, signal: SIGNAL }));
    expect(r).toBe('released');
    expect(await state(h.holdId)).toBe('released');
  });

  it('keeps the hold held when the provider fails transiently', async () => {
    const created = fake();
    const h = await hold(created.client, await newJob());
    const bad = fake({ deleteResult: 'transient' });
    const r = await withBusiness(BUSINESS, (db) => releaseHold(db, { access: accessOf(bad.client), holdId: h.holdId, signal: SIGNAL }));
    expect(r).toMatchObject({ failure: 'transient' });
    expect(await state(h.holdId)).toBe('held');
  });

  it('refuses to release an event id with no held row', async () => {
    const { client, calls } = fake();
    const r = await withBusiness(BUSINESS, (db) => releaseHold(db, { access: accessOf(client), holdId: 'H-nope', signal: SIGNAL }));
    expect(r).toMatchObject({ failure: 'rejected' });
    expect(calls).toHaveLength(0);
  });

  it('does not delete a converted hold', async () => {
    const { client, calls } = fake();
    const h = await hold(client, await newJob());
    await withBusiness(BUSINESS, (db) => markHoldConverted(db, { calendarId: 'cal-1', eventId: h.eventId }));
    expect(await state(h.holdId)).toBe('converted');
    const r = await withBusiness(BUSINESS, (db) => releaseHold(db, { access: accessOf(client), holdId: h.holdId, signal: SIGNAL }));
    expect(r).toBe('already');
    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(0);
  });

  it.each([
    ['attendees', { attendees: [{ email: 'a@b.co', response: 'accepted' as const }] }],
    ['a non-prefix title', { title: 'פגישה עם דנה' }],
    ['another organizer', { organizerIsSelf: false }],
  ])('does not delete an event that is no longer a hold (%s) and marks it converted', async (_n, current) => {
    const created = fake();
    const h = await hold(created.client, await newJob());
    const conv = fake({ current });
    const r = await withBusiness(BUSINESS, (db) => releaseHold(db, { access: accessOf(conv.client), holdId: h.holdId, signal: SIGNAL }));
    expect(r).toBe('already');
    expect(conv.calls.filter((c) => c.op === 'delete')).toHaveLength(0);
    expect(await state(h.holdId)).toBe('converted');
  });

  it('counts a getEvent not_found as released without a delete', async () => {
    const created = fake();
    const h = await hold(created.client, await newJob());
    const gone = fake({ current: 'not_found' });
    const r = await withBusiness(BUSINESS, (db) => releaseHold(db, { access: accessOf(gone.client), holdId: h.holdId, signal: SIGNAL }));
    expect(r).toBe('released');
    expect(gone.calls.filter((c) => c.op === 'delete')).toHaveLength(0);
  });

  it('never releases a hold of another business', async () => {
    const { client, calls } = fake();
    const h = await hold(client, await newJob());
    const r = await withBusiness('other-biz', (db) => releaseHold(db, { access: accessOf(client), holdId: h.holdId, signal: SIGNAL }));
    expect(r).toMatchObject({ failure: 'rejected' });
    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(0);
    expect(await state(h.holdId)).toBe('held');
  });

  it('does not delete an event another row already references when its own insert fails', async () => {
    const first = fake({ createdId: 'shared-ev' });
    await hold(first.client, await newJob());
    const second = fake({ createdId: 'shared-ev' });
    await expect(hold(second.client, await newJob())).rejects.toThrow();
    expect(second.calls.filter((c) => c.op === 'delete')).toHaveLength(0);
  });

  it('sweep releases holds of closed jobs and stale questions but never of confirmed or executing jobs', async () => {
    await withBusiness(BUSINESS, (db) => upsertBinding(db, {
        system: CALENDAR_SYSTEM,
        status: 'live',
        endpoint: null,
        credentialRef: 'OAUTH_CALENDAR',
        provider: 'google',
        lastOkAt: null,
        lastError: null,
      }, { by: 'test' }));
    const { client } = fake();
    const age = async (id: string): Promise<void> => {
      await testDb().query("UPDATE meeting_holds SET created_at = now() - interval '2 hours' WHERE hold_id = $1", [id]);
    };
    const closed = await hold(client, await newJob('closed'));
    const orphan = await hold(client, await newJob('plan')); // no confirmation row
    const askingJob = await newJob('plan');
    await addConfirmation(askingJob, 'pending');
    const waiting = await hold(client, askingJob); // fresh and still asking
    const staleJob = await newJob('plan');
    await addConfirmation(staleJob, 'pending');
    const stale = await hold(client, staleJob);
    await age(stale.holdId);
    const cancelledJob = await newJob('plan');
    await addConfirmation(cancelledJob, 'cancelled');
    const cancelled = await hold(client, cancelledJob);
    // Past the short grace a job with no pending question loses its hold.
    for (const h of [orphan, cancelled]) {
      await testDb().query("UPDATE meeting_holds SET created_at = now() - interval '6 minutes' WHERE hold_id = $1", [h.holdId]);
    }
    const keep: string[] = [];
    for (const phase of ['execute', 'verify', 'remember', 'followup', 'await_approval', 'plan']) {
      const j = await newJob(phase);
      await addConfirmation(j, 'confirmed');
      const h = await hold(client, j);
      await age(h.holdId);
      keep.push(h.holdId);
    }

    const out = await withBusiness(BUSINESS, (db) => sweepHolds(db, { runtime, client }));
    expect(out).toEqual({ released: 4, failed: 0 });
    for (const h of [closed, orphan, stale, cancelled]) expect(await state(h.holdId)).toBe('released');
    expect(await state(waiting.holdId)).toBe('held');
    for (const id of keep) expect(await state(id)).toBe('held');
  });

  it('sweep keeps a fresh hold whose job is in plan before its question row exists (the door’s gap)', async () => {
    await withBusiness(BUSINESS, (db) => upsertBinding(db, {
        system: CALENDAR_SYSTEM,
        status: 'live',
        endpoint: null,
        credentialRef: 'OAUTH_CALENDAR',
        provider: 'google',
        lastOkAt: null,
        lastError: null,
      }, { by: 'test' }));
    const { client } = fake();
    const gapJob = await newJob('plan'); // bound, moved to plan, no question yet
    const fresh = await hold(client, gapJob);
    expect(await withBusiness(BUSINESS, (db) => sweepHolds(db, { runtime, client }))).toEqual({ released: 0, failed: 0 });
    expect(await state(fresh.holdId)).toBe('held');
    // The question row lands: still held.
    await addConfirmation(gapJob, 'pending');
    expect(await withBusiness(BUSINESS, (db) => sweepHolds(db, { runtime, client }))).toEqual({ released: 0, failed: 0 });
    expect(await state(fresh.holdId)).toBe('held');
  });
});
