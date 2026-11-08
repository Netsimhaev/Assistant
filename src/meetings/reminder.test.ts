/**
 * The client reminder: an ordinary `boss` job with no exemption, one
 * `mail.send` step of class `email.initiate`, handed to the unchanged gate —
 * which, under `ask`, raises the owner's card and sends nothing.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { closePool, getPool } from '../db/pool.js';
import { Plan } from '../domain/plan.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import { createJob, loadJob } from '../orchestrator/jobs.js';
import { loadPlanBody } from '../orchestrator/plan-store.js';
import { runDueJobs } from '../orchestrator/run-due.js';
import { confirmedCommandCovers } from '../policy/confirmed-command.js';
import { buildFacts } from '../policy/facts.js';
import { refineActionClass } from '../policy/classify.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { fakeMailboxClient, installMailboxCharter, mailboxRuntime } from '../test/mailbox.js';
import { openClientReminder, reminderBody } from './reminder.js';

const B = 'test-business';
// Sunday 2026-11-08 10:00 Asia/Jerusalem.
const NOW = new Date('2026-11-08T08:00:00.000Z');
const START = new Date('2026-11-10T08:00:00.000Z'); // Tuesday 10:00 local

let charterVersion = '';

async function seedMeeting(over: { email?: string | null; verified?: boolean } = {}): Promise<string> {
  const job = await createJob({ charterVersion, provenance: 'boss', title: 'פגישה', businessId: B });
  const meetingId = `M-${job.jobId}`;
  await getPool().query(
    `INSERT INTO meetings (meeting_id, business_id, job_id, step_id, calendar_id, event_id, operation, client_name,
        client_email, client_email_verified, start_at, end_at, state)
     VALUES ($1, $2, $3, 's1', 'cal-1', 'ev-1', 'create', 'דני כהן', $4, $5, $6, $7, 'active')`,
    [
      meetingId,
      B,
      job.jobId,
      over.email === undefined ? 'dani@acme.co.il' : over.email,
      over.verified ?? true,
      START,
      new Date(START.getTime() + 3_600_000),
    ],
  );
  return meetingId;
}

beforeEach(async () => {
  await resetDatabase();
  charterVersion = (await installMailboxCharter(B)).charterVersion;
});
afterAll(async () => {
  await closePool();
});

describe('openClientReminder', () => {
  it('opens a boss job in execute with one email.initiate mail.send step and the exact body', async () => {
    const meetingId = await seedMeeting();
    const opened = await openClientReminder({ businessId: B, meetingId, location: 'רחוב הרצל 1, תל אביב' });
    if (!('jobId' in opened)) throw new Error(`expected a job, got ${opened.skipped}`);

    const job = await loadJob(opened.jobId, { businessId: B });
    expect(job?.provenance).toBe('boss');
    expect(job?.phase).toBe('execute');
    const plan = (await loadPlanBody(opened.jobId, { businessId: B }))?.plan;
    expect(plan?.steps).toHaveLength(1);
    const step = plan?.steps[0];
    expect(step?.toolName).toBe('mail.send');
    expect(step?.expectedActionClass).toBe('email.initiate');
    expect(Object.keys(step?.input ?? {}).sort()).toEqual(['body', 'subject', 'to']);
    expect(refineActionClass('email.reply', step?.input ?? {})).toBe('email.initiate');
    expect(step?.input['to']).toBe('dani@acme.co.il');
    expect(step?.input['subject']).toBe("תזכורת: פגישה ביום ג' 10/11");
    expect(step?.input['body']).toBe(
      "שלום דני כהן,\nרצינו לוודא שהפגישה ביום ג' 10/11 בשעה 10:00, רחוב הרצל 1, תל אביב, מתאימה לך. " +
        `אפשר לאשר בהזמנת היומן או להשיב למייל הזה.\nמזהה תזכורת: ${meetingId}`,
    );
    const { rows } = await getPool().query<{ reminder_job_id: string | null }>(
      'SELECT reminder_job_id FROM meetings WHERE meeting_id = $1',
      [meetingId],
    );
    expect(rows[0]?.reminder_job_id).toBe(opened.jobId);
  });

  it('reminder job has no boss_instructions row and is not covered by the confirmed-command exemption', async () => {
    const meetingId = await seedMeeting();
    const opened = await openClientReminder({ businessId: B, meetingId });
    if (!('jobId' in opened)) throw new Error('expected a job');
    const jobId = opened.jobId;

    expect((await getPool().query('SELECT 1 FROM boss_instructions WHERE job_id = $1', [jobId])).rowCount).toBe(0);
    expect((await getPool().query('SELECT 1 FROM job_authorizations WHERE job_id = $1', [jobId])).rowCount).toBe(0);

    const plan = (await loadPlanBody(jobId, { businessId: B }))?.plan ?? Plan.parse(null);
    const step = plan.steps[0];
    if (step === undefined) throw new Error('no step');
    const active = await loadActiveCharter(B);
    if (active === null) throw new Error('no charter');
    const facts = buildFacts(step.toolName, step.input, {
      provenance: 'boss',
      chainDepth: 1,
      counterpartyTags: [],
      provenanceChainDerived: false,
    });
    const covers = await confirmedCommandCovers(facts, {
      provenance: 'boss',
      chainDepth: 1,
      counterpartyTags: [],
      provenanceChainDerived: false,
      agent: step.agent,
      bundle: active.bundle,
      jobId,
      stepId: step.id,
      businessId: B,
    });
    expect(covers).toBeNull();

    // And the gate, under `ask`, raises the owner's card and sends nothing.
    await setAutonomyMode('ask', 'p_boss', { businessId: B });
    const { client, sent, sentNew } = fakeMailboxClient();
    await runDueJobs({ businessId: B, runtime: mailboxRuntime(client), now: NOW });
    expect(sent).toHaveLength(0);
    expect(sentNew).toHaveLength(0);
    expect((await loadJob(jobId, { businessId: B }))?.phase).toBe('await_approval');
    const cards = await getPool().query(`SELECT 1 FROM approval_requests WHERE job_id = $1 AND state = 'pending'`, [jobId]);
    expect(cards.rowCount).toBe(1);
  });

  it('reminds an unverified address — it is where the invitation went', async () => {
    const meetingId = await seedMeeting({ verified: false });
    expect('jobId' in (await openClientReminder({ businessId: B, meetingId }))).toBe(true);
  });

  it('skips a meeting with no email, one already reminded, and a charter with no mailbox', async () => {
    const noEmail = await seedMeeting({ email: null });
    expect(await openClientReminder({ businessId: B, meetingId: noEmail })).toEqual({ skipped: 'no_email' });

    const once = await seedMeeting();
    expect('jobId' in (await openClientReminder({ businessId: B, meetingId: once }))).toBe(true);
    expect(await openClientReminder({ businessId: B, meetingId: once })).toEqual({ skipped: 'already' });

    await resetDatabase();
    charterVersion = (await installCharter(buildCharter(), { businessId: B })).charterVersion;
    const noMailbox = await seedMeeting();
    expect(await openClientReminder({ businessId: B, meetingId: noMailbox })).toEqual({ skipped: 'no_mailbox' });
    const { rows } = await getPool().query<{ n: string }>('SELECT count(*) AS n FROM jobs WHERE business_id = $1', [B]);
    expect(Number(rows[0]?.n)).toBe(1); // only the meeting's own job
  });

  it('omits the location when there is none, and cleans the name', () => {
    expect(
      reminderBody({ meetingId: 'M-1', clientName: 'דנה‮', startMs: START.getTime(), location: null, timeZone: 'Asia/Jerusalem' }),
    ).toBe(
      "שלום דנה,\nרצינו לוודא שהפגישה ביום ג' 10/11 בשעה 10:00, מתאימה לך. אפשר לאשר בהזמנת היומן או להשיב למייל הזה.\nמזהה תזכורת: M-1",
    );
  });
});
