/**
 * The schedule answer through the WhatsApp door (calendar scheduling §7.1):
 * a read, judged on the new message alone before any routing — no job, no
 * instruction row, no claim on a parked question, no cap spent, and the schedule
 * text is sent as-is (no route notice, no transcript echo).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CALENDAR_SYSTEM } from '../calendar/calendar.js';
import type { CalendarClient, CalendarEvent } from '../calendar/types.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { config } from '../config.js';
import { closePool, getPool, withBusiness } from '../db/pool.js';
import type { Plan } from '../domain/plan.js';
import { answerScheduleQuery } from '../meetings/door.js';
import { createFakeGateway } from '../whatsapp/fake-gateway.js';
import { createFakeMessenger } from '../whatsapp/fake-messenger.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { appendAudit } from '../audit/log.js';
import { buildCharter } from '../test/fixtures.js';
import { resetDatabase } from '../test/db.js';
import { canonicalHash } from '../util/canonical.js';
import { localParts, localToInstant } from '../util/local-time.js';
import { upsertBinding } from './bindings.js';
import type { CredentialSource } from './credentials.js';
import { runWhatsAppDoor } from './whatsapp-door.js';

const BUSINESS = 'test-business';
const PRINCIPAL_NUMBER = '+972500000000';
const TZ = 'Asia/Jerusalem';

const CREDENTIALS: CredentialSource = {
  async resolve(ref) {
    return { ref, value: 'access-token' } as never;
  },
};

function tomorrowAt(hhmm: string): string {
  const [y, mo, d] = localParts(new Date(), TZ).date.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
  return localToInstant(date, hhmm, TZ).toISOString();
}

const CLIENT: CalendarClient = {
  listCalendars: async () => [{ calendarId: 'primary-id', name: 'העסק', primary: true, canWrite: true }],
  listEvents: async () => ({
    events: [
      {
        calendarId: 'primary-id', eventId: 'evt-1', title: 'דני כהן', start: tomorrowAt('10:00'), end: tomorrowAt('11:00'),
        allDay: false, location: 'הרצל 5', description: null, organizerIsSelf: true, busy: true, selfDeclined: false,
        transactionId: null, attendees: [],
      } satisfies CalendarEvent,
    ],
    truncated: false,
  }),
} as unknown as CalendarClient;

const CALENDAR = { runtime: { credentials: CREDENTIALS }, client: CLIENT };

let nextId = 0;
function owner(body: string) {
  nextId += 1;
  return {
    providerMessageId: `wamid.sched-${nextId}`,
    senderNumber: PRINCIPAL_NUMBER,
    body,
    mediaKind: null,
    providerTimestamp: new Date().toISOString(),
  };
}

/** The fake messenger, remembering the `jobId` each text was sent with. */
function recordingMessenger(): { messenger: BossMessenger; jobIds: (string | null)[]; texts: string[] } {
  const fake = createFakeMessenger();
  const jobIds: (string | null)[] = [];
  const messenger = {
    ...fake,
    async send(input: { text: string; jobId: string | null }) {
      jobIds.push(input.jobId);
      return fake.send(input);
    },
  } as unknown as BossMessenger;
  return { messenger, jobIds, texts: fake.sentTexts };
}

async function expectedSchedule(text: string): Promise<string> {
  const active = await withBusiness(BUSINESS, (bdb) => loadActiveCharter(bdb));
  if (active === null) throw new Error('no charter');
  const r = await answerScheduleQuery({
    text, businessId: BUSINESS, timeZone: active.charter.identity.timezone, operations: active.charter.operations,
    runtime: CALENDAR.runtime, client: CLIENT,
  });
  if (r === null) throw new Error('not a schedule question');
  return r.answered;
}

async function count(sql: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(sql);
  return Number(rows[0]?.n);
}

const clarifyingPlan: Plan = {
  goal: 'לשלוח הודעה', assumptions: [], clarifyingQuestion: 'לאיזו רונית?', estimatedCostMinor: 0,
  steps: [{
    id: 's1', agent: 'comms.email', intent: 'לשלוח', toolName: 'mail.send',
    input: { to: 'dana@example.com', subject: 'נושא', body: 'גוף' }, dependsOn: [], expectedActionClass: 'email.initiate',
  }],
};

beforeEach(async () => {
  await resetDatabase();
  await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()));
  await withBusiness(BUSINESS, (db) => upsertBinding(db, { system: CALENDAR_SYSTEM, status: 'live', endpoint: null, credentialRef: 'OAUTH_CALENDAR', provider: 'google', lastOkAt: null, lastError: null }, { by: 'test' }));
});
afterAll(async () => {
  await closePool();
});

describe('WhatsApp door: schedule question', () => {
  it('sends exactly the rendered schedule, with no job, no link and the message settled handled', async () => {
    const gateway = createFakeGateway();
    const { messenger, jobIds, texts } = recordingMessenger();
    const msg = owner('מה יש לי מחר?');
    gateway.enqueue(msg);

    const result = await withBusiness(BUSINESS, (db) => runWhatsAppDoor(db, { gateway, messenger, calendar: CALENDAR }));

    const expected = await expectedSchedule('מה יש לי מחר?');
    expect(expected).toContain('*10:00–11:00 · דני כהן*');
    expect(texts).toEqual([expected]); // nothing else: no route notice, no transcript echo
    expect(jobIds).toEqual([null]);
    expect(result.instructed).toBe(1);
    expect(result.refused).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM jobs')).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM boss_instructions')).toBe(0);
    const { rows } = await getPool().query<{ state: string; job_id: string | null }>(
      'SELECT state, job_id FROM whatsapp_messages WHERE provider_message_id = $1',
      [msg.providerMessageId],
    );
    expect(rows[0]).toEqual({ state: 'handled', job_id: null });
  });

  it('is neither counted against nor refused by the daily instruction cap', async () => {
    for (let i = 0; i < config.whatsappInstructionsPerDay; i += 1) {
      await withBusiness(BUSINESS, (bdb) => appendAudit(
        bdb,
        {
          actor: 'orchestrator', kind: 'whatsapp_instruction', charterVersion: 'n/a', provenance: 'boss',
          inputHash: canonicalHash({ seeded: i }), artifacts: [], costMinor: null, tokens: null, reason: 'seed',
        }
      ));
    }
    const before = await count("SELECT count(*)::text AS n FROM audit_log WHERE kind = 'whatsapp_instruction'");
    const gateway = createFakeGateway();
    const { messenger, texts } = recordingMessenger();
    gateway.enqueue(owner('מה יש לי מחר'));
    await withBusiness(BUSINESS, (db) => runWhatsAppDoor(db, { gateway, messenger, calendar: CALENDAR }));
    expect(texts).toEqual([await expectedSchedule('מה יש לי מחר')]);
    expect(await count("SELECT count(*)::text AS n FROM audit_log WHERE kind = 'whatsapp_instruction'")).toBe(before);
  });

  it('leaves a parked question open and unclaimed, and reads the range from the new message alone', async () => {
    const gateway = createFakeGateway();
    const { messenger, texts } = recordingMessenger();
    gateway.enqueue(owner('תשלחי לרונית מחר'));
    await withBusiness(BUSINESS, (db) => runWhatsAppDoor(db, {
      gateway, messenger, calendar: CALENDAR,
      planner: async () => ({ status: 'planned', plan: clarifyingPlan }),
    }));
    const parked = await getPool().query<{ job_id: string }>('SELECT job_id FROM boss_instructions');
    expect(parked.rows).toHaveLength(1);
    const jobsBefore = await count('SELECT count(*)::text AS n FROM jobs');

    gateway.enqueue(owner('מה יש לי ביום שלישי'));
    await withBusiness(BUSINESS, (db) => runWhatsAppDoor(db, {
      gateway, messenger, calendar: CALENDAR,
      planner: async () => {
        throw new Error('planner must not run for a schedule question');
      },
    }));

    expect(texts[1]).toBe(await expectedSchedule('מה יש לי ביום שלישי'));
    expect(texts[1]).not.toContain('הוספתי את זה לבקשה הקודמת');
    const row = await getPool().query<{ answer: string | null }>('SELECT answer FROM boss_instructions');
    expect(row.rows[0]?.answer).toBeNull();
    const job = await getPool().query<{ phase: string }>('SELECT phase FROM jobs WHERE job_id = $1', [parked.rows[0]?.job_id]);
    expect(['closed', 'failed', 'halted']).not.toContain(job.rows[0]?.phase);
    expect(await count('SELECT count(*)::text AS n FROM jobs')).toBe(jobsBefore);
  });
});
