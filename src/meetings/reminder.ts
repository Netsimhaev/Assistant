/**
 * A reminder to a client who has not answered a meeting invitation (calendar
 * scheduling, spec §8.3), opened in the pattern of `openNudge`
 * (`src/ledger/nudge.ts`): an ordinary job that passes the UNCHANGED gate.
 *
 * **The reminder job carries no exemption, by construction.** It is created
 * with `provenance: 'boss'` (the meeting was confirmed by the owner) and
 * NOTHING else: no `boss_instructions` row — so `confirmedCommandCovers`,
 * which joins on one, can never carry it — no `grantAuthorization`, no
 * approval. Its one step is `mail.send` with `{ to, subject, body }` only: no
 * threading field, so `refineActionClass` reads it as `email.initiate`, which
 * today's charter holds at `approve_required`. Under the dial's `ask`/`learn`
 * the owner gets a card; nothing is sent on its own.
 *
 * **Under a dial that holds `email.initiate` at `draft_only` (the default
 * `off`), no job is opened.** The gate would refuse the step at stage 8, the
 * job would fail without a card, and the failure would count toward
 * `promote.ts`'s `failureCount` — while the owner had been told a card was
 * waiting. So the CLAMPED ramp is read first, with `loadRampLevel` (the same
 * function the runner feeds the gate), and at `draft_only` the reminder text
 * is returned for the owner to send himself (`draftedForOwner`, without the
 * `מזהה תזכורת` line, which exists only to defeat a mail provider's dedup).
 *
 * **The recipient is the row's `client_email`** — the address the invitation
 * went to. An unverified address is still that address, so it is reminded;
 * the gate's card shows it and the owner approves. No address → no reminder.
 *
 * **The body is deterministic** — no model writes it — and carries
 * `מזהה תזכורת: <meetingId>`, because a mail provider's dedup keys are derived
 * from content and two reminders to the same client on the same day would
 * otherwise be byte-identical.
 */
import type { ActiveCharter } from '../charter/store.js';
import { loadActiveCharter } from '../charter/store.js';
import { getPool, withBusiness, type Queryable } from '../db/pool.js';
import { Plan } from '../domain/plan.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { loadRampLevel } from '../orchestrator/ramp.js';
import { bindPlanToJob, loadPlanBody } from '../orchestrator/plan-store.js';
import { stripBidiControls, toOneLine } from '../util/bidi.js';
import { hhmm, localDateLabel, localWeekdayLabel } from './query.js';
import { loadMeetingSettings } from './settings.js';

export type ReminderSkip = 'no_mailbox' | 'no_email' | 'already';

interface ReminderRow {
  meeting_id: string;
  job_id: string;
  step_id: string;
  client_name: string;
  client_email: string | null;
  start_at: Date | null;
  reminder_job_id: string | null;
}

function clean(value: string | null | undefined): string {
  return value === null || value === undefined ? '' : toOneLine(stripBidiControls(value)).trim();
}

/** Whether the active charter routes `mail.send` through any connection. */
export function charterServesMailSend(active: ActiveCharter): boolean {
  return active.charter.connections.some((c) => c.serves.includes('mail.send'));
}

export function reminderSubject(startMs: number, timeZone: string): string {
  return `תזכורת: פגישה ב${localWeekdayLabel(startMs, timeZone)} ${localDateLabel(startMs, timeZone)}`;
}

export function reminderBody(o: {
  /** `null` drops the `מזהה תזכורת` line (the text handed to the owner). */
  meetingId: string | null;
  clientName: string;
  startMs: number;
  location: string | null;
  timeZone: string;
}): string {
  const name = clean(o.clientName);
  const location = clean(o.location);
  const when = `${localWeekdayLabel(o.startMs, o.timeZone)} ${localDateLabel(o.startMs, o.timeZone)} בשעה ${hhmm(o.startMs, o.timeZone)}`;
  return (
    `שלום ${name},\n` +
    `רצינו לוודא שהפגישה ב${when}${location === '' ? '' : `, ${location}`}, מתאימה לך. ` +
    `אפשר לאשר בהזמנת היומן או להשיב למייל הזה.` +
    (o.meetingId === null ? '' : `\nמזהה תזכורת: ${o.meetingId}`)
  );
}

/** The step's own `location`, else the fixed address of a fixed-location business, else none. */
async function storedLocation(row: ReminderRow, businessId: string, db: Queryable): Promise<string | null> {
  try {
    const stored = await withBusiness(businessId, (bdb) => loadPlanBody(bdb, row.job_id)); // TENANCY-TODO(task 5)
    const step = stored?.plan.steps.find((s) => s.id === row.step_id);
    const loc = step?.input['location'];
    if (typeof loc === 'string' && loc.trim() !== '') return loc;
  } catch {
    // An unreadable stored plan: fall through to the settings.
  }
  const settings = await loadMeetingSettings({ businessId, db });
  return settings.locationKind === 'fixed' ? settings.fixedAddress : null;
}

export async function openClientReminder(o: {
  businessId: string;
  meetingId: string;
  db?: Queryable;
  /** The event's current location, when the caller just read it from the calendar. */
  location?: string | null;
}): Promise<{ jobId: string } | { draftedForOwner: string } | { skipped: ReminderSkip }> {
  const { businessId } = o;
  const db = o.db ?? getPool();
  const { rows } = await db.query<ReminderRow>(
    `SELECT meeting_id, job_id, step_id, client_name, client_email, start_at, reminder_job_id
       FROM meetings WHERE business_id = $1 AND meeting_id = $2`,
    [businessId, o.meetingId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`openClientReminder: no meeting ${o.meetingId}`);
  if (row.reminder_job_id !== null) return { skipped: 'already' };
  const to = row.client_email === null ? '' : row.client_email.trim();
  if (to === '' || row.start_at === null) return { skipped: 'no_email' };

  const active = await withBusiness(businessId, (bdb) => loadActiveCharter(bdb)); // TENANCY-TODO(task 5)
  if (active === null) return { skipped: 'no_mailbox' };
  const timeZone = active.charter.identity.timezone;
  const startMs = row.start_at.getTime();
  const location = o.location !== undefined ? o.location : await storedLocation(row, businessId, db);

  // The gate would refuse a draft_only step at stage 8: hand the text to the
  // owner instead of opening a job that can only fail.
  if ((await withBusiness(businessId, (bdb) => loadRampLevel(bdb, 'email.initiate'))) === 'draft_only') { // TENANCY-TODO(task 5)
    return {
      draftedForOwner: reminderBody({ meetingId: null, clientName: row.client_name, startMs, location, timeZone }),
    };
  }
  if (!charterServesMailSend(active)) return { skipped: 'no_mailbox' };
  const plan = Plan.parse({
    goal: `תזכורת לפגישה: ${clean(row.client_name).slice(0, 80)}`,
    steps: [
      {
        id: 'reminder',
        agent: 'comms.email',
        intent: 'follow_up',
        toolName: 'mail.send',
        // `{ to, subject, body }` only: no threading field, so the gate reads
        // `email.initiate` and today's charter asks the owner.
        input: {
          to,
          subject: reminderSubject(startMs, timeZone),
          body: reminderBody({ meetingId: row.meeting_id, clientName: row.client_name, startMs, location, timeZone }),
        },
        dependsOn: [],
        expectedActionClass: 'email.initiate',
      },
    ],
  });

  let jobId: string | null = null;
  try {
    const job = await withBusiness(businessId, (db) => createJob(db, { // TENANCY-TODO(task 5)
      charterVersion: active.bundle.charterVersion,
      // A literal, not a parameter: the meeting was confirmed by the owner.
      // No boss_instructions row is written for this job, ever.
      provenance: 'boss',
      title: `תזכורת לפגישה: ${clean(row.client_name).slice(0, 80)}`,
    }));
    jobId = job.jobId;
    for (const to2 of ['understand', 'plan'] as const) {
      await withBusiness(businessId, (db) => transition(db, job.jobId, { to: to2, actor: 'orchestrator', reason: 'meeting reminder: client has not answered' })); // TENANCY-TODO(task 5)
    }
    const bound = await withBusiness(businessId, (db) => bindPlanToJob(db, job.jobId, plan)); // TENANCY-TODO(task 5)
    if (bound.status === 'conflict') throw new Error(`meeting reminder: plan conflict on fresh job ${job.jobId}`);
    const linked = await db.query(
      `UPDATE meetings SET reminder_job_id = $3
        WHERE business_id = $1 AND meeting_id = $2 AND reminder_job_id IS NULL`,
      [businessId, row.meeting_id, job.jobId],
    );
    if ((linked.rowCount ?? 0) === 0) {
      await withBusiness(businessId, (db) => transition(db, job.jobId, { to: 'closed', actor: 'orchestrator', reason: 'meeting reminder: already opened' })); // TENANCY-TODO(task 5)
      return { skipped: 'already' };
    }
    await withBusiness(businessId, (db) => transition(db, job.jobId, { to: 'execute', actor: 'orchestrator', reason: 'meeting reminder: to the gate' })); // TENANCY-TODO(task 5)
    return { jobId: job.jobId };
  } catch (err) {
    if (jobId !== null) {
      const openedJobId = jobId;
      try {
        await withBusiness(businessId, (db) => transition(db, openedJobId, { // TENANCY-TODO(task 5)
          to: 'failed',
          actor: 'orchestrator',
          reason: `meeting_reminder_open_failed — ${err instanceof Error ? err.message : String(err)}`,
        }));
      } catch {
        // Already terminal or unreachable.
      }
    }
    throw err;
  }
}
