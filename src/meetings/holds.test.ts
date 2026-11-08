import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { config } from '../config.js';
import { closePool, getPool } from '../db/pool.js';
import { upsertBinding } from '../orchestrator/bindings.js';
import { createJob } from '../orchestrator/jobs.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { CALENDAR_SYSTEM, HOLD_TITLE_PREFIX } from '../calendar/calendar.js';
import type { CalendarAccess } from '../calendar/client-for.js';
import type { CalendarClient, EventWrite } from '../calendar/types.js';
import { createHold, markHoldConverted, releaseHold, sweepHolds } from './holds.js';

const BUSINESS = config.businessId;
const SIGNAL = new AbortController().signal;

interface Call {
  op: string;
  args: unknown[];
}

function fake(opts: { deleteResult?: 'not_found' | 'transient' } = {}): { client: CalendarClient; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const unused = async (): Promise<never> => {
    throw new Error('holds must not call this');
  };
  const client: CalendarClient = {
    listCalendars: unused,
    listEvents: unused,
    getEvent: unused,
    updateEvent: unused,
    async createEvent(...args) {
      calls.push({ op: 'create', args });
      n += 1;
      return { eventId: `ev-${n}` };
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
  const job = await createJob({ charterVersion, provenance: 'boss', title: 't' });
  await getPool().query('UPDATE jobs SET phase = $1 WHERE job_id = $2', [phase, job.jobId]);
  return job.jobId;
}

async function hold(client: CalendarClient, jobId: string, name = 'דנה לוי') {
  const r = await createHold({
    access: accessOf(client),
    businessId: BUSINESS,
    jobId,
    calendarId: 'cal-1',
    start: '2026-11-10T08:00:00.000Z',
    end: '2026-11-10T09:00:00.000Z',
    clientName: name,
    signal: SIGNAL,
  });
  if ('failure' in r) throw new Error('hold failed');
  return r;
}

async function state(holdId: string): Promise<string> {
  const { rows } = await getPool().query<{ state: string }>('SELECT state FROM meeting_holds WHERE hold_id = $1', [holdId]);
  return rows[0]?.state ?? 'missing';
}

async function addConfirmation(jobId: string, st: string): Promise<void> {
  await getPool().query(
    `INSERT INTO instruction_confirmations (business_id, job_id, options, presented_text, channel, state, chosen_plan_hash)
     VALUES ($1, $2, '[]'::jsonb, 'q', 'whatsapp', $3, $4)`,
    [BUSINESS, jobId, st, st === 'confirmed' ? 'h' : null],
  );
}

const runtime = { credentials: { resolve: async () => ({ value: 'tok' }) } } as never;

beforeEach(async () => {
  await resetDatabase();
  charterVersion = (await installCharter(buildCharter(), { businessId: BUSINESS })).charterVersion;
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
    expect(calls[0]?.args[3]).toBe(`hold:${jobId}`);
    expect(await state(h.holdId)).toBe('held');

    const { rows } = await getPool().query<Record<string, unknown>>(
      "SELECT * FROM audit_log WHERE reason = 'calendar_hold:created'",
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0], (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain('לוי');
    expect(JSON.stringify(rows[0], (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain('דנה');
  });

  it('release deletes only a hold it created', async () => {
    const { client, calls } = fake();
    const h = await hold(client, await newJob());
    const r = await releaseHold({ access: accessOf(client), businessId: BUSINESS, holdId: h.holdId, signal: SIGNAL });
    expect(r).toBe('released');
    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(1);
    expect(calls[1]?.args[2]).toBe(h.eventId);
    expect(await state(h.holdId)).toBe('released');
    const again = await releaseHold({ access: accessOf(client), businessId: BUSINESS, holdId: h.holdId, signal: SIGNAL });
    expect(again).toBe('already');
    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(1);
  });

  it('counts a provider not_found as released', async () => {
    const created = fake();
    const h = await hold(created.client, await newJob());
    const gone = fake({ deleteResult: 'not_found' });
    const r = await releaseHold({ access: accessOf(gone.client), businessId: BUSINESS, holdId: h.holdId, signal: SIGNAL });
    expect(r).toBe('released');
    expect(await state(h.holdId)).toBe('released');
  });

  it('keeps the hold held when the provider fails transiently', async () => {
    const created = fake();
    const h = await hold(created.client, await newJob());
    const bad = fake({ deleteResult: 'transient' });
    const r = await releaseHold({ access: accessOf(bad.client), businessId: BUSINESS, holdId: h.holdId, signal: SIGNAL });
    expect(r).toMatchObject({ failure: 'transient' });
    expect(await state(h.holdId)).toBe('held');
  });

  it('refuses to release an event id with no held row', async () => {
    const { client, calls } = fake();
    const r = await releaseHold({ access: accessOf(client), businessId: BUSINESS, holdId: 'H-nope', signal: SIGNAL });
    expect(r).toMatchObject({ failure: 'rejected' });
    expect(calls).toHaveLength(0);
  });

  it('does not delete a converted hold', async () => {
    const { client, calls } = fake();
    const h = await hold(client, await newJob());
    await markHoldConverted({ businessId: BUSINESS, eventId: h.eventId });
    expect(await state(h.holdId)).toBe('converted');
    const r = await releaseHold({ access: accessOf(client), businessId: BUSINESS, holdId: h.holdId, signal: SIGNAL });
    expect(r).toBe('already');
    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(0);
  });

  it('sweep releases holds of closed jobs and expired questions but not of executing jobs', async () => {
    await upsertBinding(
      {
        system: CALENDAR_SYSTEM,
        status: 'live',
        endpoint: null,
        credentialRef: 'OAUTH_CALENDAR',
        provider: 'google',
        lastOkAt: null,
        lastError: null,
      },
      { businessId: BUSINESS, by: 'test' },
    );
    const { client } = fake();
    const closed = await hold(client, await newJob('closed'));
    const orphan = await hold(client, await newJob('plan')); // no confirmation row: question gone
    const executing = await hold(client, await newJob('execute'));
    const asking = await newJob('plan');
    await addConfirmation(asking, 'pending');
    const waiting = await hold(client, asking);
    const confirmedJob = await newJob('plan');
    await addConfirmation(confirmedJob, 'confirmed');
    const confirmed = await hold(client, confirmedJob);
    const old = await newJob('plan');
    await addConfirmation(old, 'pending');
    const stale = await hold(client, old);
    await getPool().query(
      "UPDATE meeting_holds SET created_at = now() - interval '2 hours' WHERE hold_id = $1",
      [stale.holdId],
    );

    const out = await sweepHolds({ businessId: BUSINESS, runtime, client });
    expect(out).toEqual({ released: 3, failed: 0 });
    expect(await state(closed.holdId)).toBe('released');
    expect(await state(orphan.holdId)).toBe('released');
    expect(await state(stale.holdId)).toBe('released');
    expect(await state(executing.holdId)).toBe('held');
    expect(await state(waiting.holdId)).toBe('held');
    expect(await state(confirmed.holdId)).toBe('held');
  });
});
