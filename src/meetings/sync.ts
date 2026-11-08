/**
 * The meetings sweep (calendar scheduling, spec §8): every scheduler pass
 * moves the assistant's own meeting rows forward and keeps the owner told.
 *
 *   1. `proposed` → `active` once the job's calendar step completed (the
 *      event id is the step's `external_id`; a hold it took over is marked
 *      converted). A job that ended without a completed step → `abandoned`.
 *      On activation of a move/update/cancel, earlier `active` rows of the
 *      same event → `done`; a move/update row starts its own response over
 *      (§8.1: a yes to the old time is not a yes to the new one); a `cancel`
 *      row goes straight to `done`.
 *   2. Future `active` rows still waiting (`needs_action`/`tentative`) are read
 *      back from the calendar: the attendee whose email is the row's
 *      `client_email` carries the response. The calendar is the only source
 *      that changes a response on its own (§8.2).
 *   3. A newly `declined` meeting → one owner alert (§8.4). Stamped before it
 *      is sent: at most once, never twice.
 *   4. A meeting still unanswered after the wait (24h, or 2h when it starts in
 *      under a day — `meeting_settings`, measured from activation) → the slot
 *      is claimed, a client reminder is opened through the gate (never sent on
 *      its own, `reminder.ts`), and the owner is told once (§8.3).
 *   5. `sweepHolds`.
 *
 * Nothing here throws on one meeting's failure: it is counted and the sweep
 * moves on. A calendar that cannot be reached skips step 2 only.
 *
 * Calendar-derived and client text reaches the owner only through
 * `stripBidiControls` + `toOneLine`.
 */
import { loadActiveCharter } from '../charter/store.js';
import { resolveCalendarAccess, type CalendarAccess } from '../calendar/client-for.js';
import { isCalendarFailure, type AttendeeResponse, type CalendarClient } from '../calendar/types.js';
import { getPool, withTransaction } from '../db/pool.js';
import { loadActionUpdateSettings } from '../governance/action-update-settings.js';
import { NOTIFY_TIMEOUT_MS } from '../governance/notify.js';
import { deliver } from '../ledger/pass.js';
import type { Runtime } from '../orchestrator/runtime.js';
import { stripBidiControls, toOneLine } from '../util/bidi.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { markHoldConverted, sweepHolds } from './holds.js';
import { hhmm, localWeekdayLabel } from './query.js';
import { openClientReminder, type ReminderSkip } from './reminder.js';
import { loadMeetingSettings } from './settings.js';

export interface MeetingSyncResult {
  activated: number;
  abandoned: number;
  responsesChanged: number;
  declinedAlerts: number;
  remindersOpened: number;
  unansweredAlerts: number;
  holdsReleased: number;
  /** Per-meeting failures counted and skipped (the sweep never throws on one). */
  errored: number;
}

export type SendAlert = (subject: string, body: string) => Promise<{ ok: boolean; error?: string }>;

const HOUR_MS = 60 * 60 * 1000;
const SOON_MS = 24 * HOUR_MS;
const CALENDAR_CALL_TIMEOUT_MS = 30_000;
const ABANDON_PHASES = new Set(['failed', 'closed', 'halted']);

interface ProposedRow {
  meeting_id: string;
  operation: 'create' | 'move' | 'update' | 'cancel';
  calendar_id: string;
  event_id: string | null;
  client_email: string | null;
  phase: string | null;
  step_status: string | null;
  external_id: string | null;
}

interface ActiveRow {
  meeting_id: string;
  calendar_id: string;
  event_id: string | null;
  client_name: string;
  client_email: string | null;
  start_at: Date | null;
  response: string;
  updated_at: Date;
}

function clean(value: string): string {
  return toOneLine(stripBidiControls(value)).trim();
}

/** Step 1 for one row. Returns what happened to it. */
async function settleProposed(businessId: string, row: ProposedRow, now: Date): Promise<'activated' | 'abandoned' | null> {
  if (row.step_status === 'completed') {
    const eventId = row.external_id ?? row.event_id;
    const freshResponse = row.client_email === null ? 'not_updated' : 'needs_action';
    const moved = await withTransaction(async (tx) => {
      const terminal = row.operation === 'cancel';
      const updated = await tx.query(
        `UPDATE meetings
            SET state = $3, event_id = $4, response = $5, response_at = NULL,
                reminder_claimed_at = NULL, reminder_job_id = NULL,
                declined_notified_at = NULL, unanswered_notified_at = NULL, updated_at = $6
          WHERE business_id = $1 AND meeting_id = $2 AND state = 'proposed'`,
        [businessId, row.meeting_id, terminal ? 'done' : 'active', eventId, freshResponse, now],
      );
      if ((updated.rowCount ?? 0) === 0) return false;
      if (row.operation !== 'create' && eventId !== null) {
        // §8.1: the earlier rows of this event describe a time (or an event)
        // that no longer is; their answers do not carry over.
        await tx.query(
          `UPDATE meetings SET state = 'done', updated_at = $4
            WHERE business_id = $1 AND event_id = $2 AND state = 'active' AND meeting_id <> $3`,
          [businessId, eventId, row.meeting_id, now],
        );
      }
      return true;
    });
    if (!moved) return null;
    if (row.operation === 'create' && row.event_id !== null) {
      // The create carried a hold: the placeholder is now the meeting.
      await markHoldConverted({ businessId, calendarId: row.calendar_id, eventId: row.event_id });
    }
    return 'activated';
  }
  if (row.phase === null || ABANDON_PHASES.has(row.phase)) {
    const updated = await getPool().query(
      `UPDATE meetings SET state = 'abandoned', updated_at = $3
        WHERE business_id = $1 AND meeting_id = $2 AND state = 'proposed'`,
      [businessId, row.meeting_id, now],
    );
    return (updated.rowCount ?? 0) > 0 ? 'abandoned' : null;
  }
  return null;
}

/** The owner's alert, through each channel of the action-update settings; never throws. */
async function alertOwner(
  o: { businessId: string; sendAlert?: SendAlert; messenger?: BossMessenger; dashboardBaseUrl?: string },
  subject: string,
  text: string,
): Promise<void> {
  let settings;
  try {
    settings = await loadActionUpdateSettings({ businessId: o.businessId });
  } catch {
    return;
  }
  const link =
    o.dashboardBaseUrl !== undefined && o.dashboardBaseUrl.length > 0
      ? `\n${o.dashboardBaseUrl.replace(/\/+$/, '')}/meetings`
      : '';
  const sendAlert = o.sendAlert;
  if (settings.toEmail && sendAlert !== undefined) {
    await deliver(() => sendAlert(subject, `${text}${link}`), NOTIFY_TIMEOUT_MS);
  }
  const messenger = o.messenger;
  if (settings.toWhatsApp && messenger !== undefined) {
    await deliver(() => messenger.send({ text, jobId: null }), NOTIFY_TIMEOUT_MS);
  }
}

function when(startMs: number, timeZone: string): string {
  return `${localWeekdayLabel(startMs, timeZone)} ${hhmm(startMs, timeZone)}`;
}

export function declinedAlertText(name: string, startMs: number, timeZone: string): string {
  return `❌ ${clean(name)} דחה את ${when(startMs, timeZone)}. כתבי לי מועד חדש או "תציעי מועדים".`;
}

export function unansweredAlertText(
  name: string,
  startMs: number,
  timeZone: string,
  outcome: 'opened' | ReminderSkip | 'open_failed',
): string {
  const head = `⏳ ${clean(name)} עדיין לא אישר את ${when(startMs, timeZone)}`;
  switch (outcome) {
    case 'opened':
    case 'already':
      return `${head} — הכנתי תזכורת לאישורך.`;
    case 'no_email':
      return `${head} — אין לו כתובת, כדאי לעדכן אותו בעצמך.`;
    case 'no_mailbox':
      return `${head} — אין תיבת מייל מחוברת, כדאי לעדכן אותו בעצמך.`;
    case 'open_failed':
      return `${head} — לא הצלחתי להכין תזכורת, כדאי לעדכן אותו בעצמך.`;
  }
}

export async function syncMeetings(o: {
  businessId: string;
  runtime: Pick<Runtime, 'credentials'>;
  now?: Date;
  sendAlert?: SendAlert;
  messenger?: BossMessenger;
  dashboardBaseUrl?: string;
  client?: CalendarClient;
}): Promise<MeetingSyncResult> {
  const { businessId } = o;
  const now = o.now ?? new Date();
  const db = getPool();
  const result: MeetingSyncResult = {
    activated: 0,
    abandoned: 0,
    responsesChanged: 0,
    declinedAlerts: 0,
    remindersOpened: 0,
    unansweredAlerts: 0,
    holdsReleased: 0,
    errored: 0,
  };
  const owner = {
    businessId,
    ...(o.sendAlert !== undefined ? { sendAlert: o.sendAlert } : {}),
    ...(o.messenger !== undefined ? { messenger: o.messenger } : {}),
    ...(o.dashboardBaseUrl !== undefined ? { dashboardBaseUrl: o.dashboardBaseUrl } : {}),
  };

  // 1. proposed → active / abandoned / done.
  await db.query(
    `UPDATE meetings SET response = 'not_updated'
      WHERE business_id = $1 AND state = 'proposed' AND client_email IS NULL AND response <> 'not_updated'`,
    [businessId],
  );
  const { rows: proposed } = await db.query<ProposedRow>(
    `SELECT m.meeting_id, m.operation, m.calendar_id, m.event_id, m.client_email,
            j.phase, r.status AS step_status, r.external_id
       FROM meetings m
       LEFT JOIN jobs j ON j.job_id = m.job_id AND j.business_id = m.business_id
       LEFT JOIN job_plans p ON p.job_id = m.job_id AND p.business_id = m.business_id
       LEFT JOIN job_step_results r
              ON r.business_id = m.business_id AND r.job_id = m.job_id
             AND r.step_id = m.step_id AND r.plan_hash = p.plan_hash
      WHERE m.business_id = $1 AND m.state = 'proposed'
      ORDER BY m.created_at, m.meeting_id`,
    [businessId],
  );
  for (const row of proposed) {
    try {
      const outcome = await settleProposed(businessId, row, now);
      if (outcome === 'activated') result.activated += 1;
      else if (outcome === 'abandoned') result.abandoned += 1;
    } catch {
      result.errored += 1;
    }
  }

  // Steps 2–4 need the charter's time zone; without a readable charter they wait.
  let timeZone: string | null = null;
  try {
    timeZone = (await loadActiveCharter(businessId))?.charter.identity.timezone ?? null;
  } catch {
    timeZone = null;
  }

  if (timeZone !== null) {
    const tz = timeZone;
    const locations = new Map<string, string | null>();

    // 2. Read the waiting responses back from the calendar.
    const { rows: waiting } = await db.query<ActiveRow>(
      `SELECT meeting_id, calendar_id, event_id, client_name, client_email, start_at, response, updated_at
         FROM meetings
        WHERE business_id = $1 AND state = 'active' AND client_email IS NOT NULL AND event_id IS NOT NULL
          AND start_at > $2 AND response IN ('needs_action', 'tentative')
        ORDER BY start_at, meeting_id`,
      [businessId, now],
    );
    if (waiting.length > 0) {
      let access: CalendarAccess | null = null;
      try {
        const resolved = await resolveCalendarAccess({
          businessId,
          runtime: o.runtime,
          ...(o.client ? { client: o.client } : {}),
        });
        access = 'unavailable' in resolved ? null : resolved;
      } catch {
        access = null;
      }
      if (access !== null) {
        for (const row of waiting) {
          try {
            const event = await access.client.getEvent(
              access.token,
              row.calendar_id,
              row.event_id as string,
              tz,
              AbortSignal.timeout(CALENDAR_CALL_TIMEOUT_MS),
            );
            if (isCalendarFailure(event)) {
              if (event.failure !== 'not_found') result.errored += 1;
              continue;
            }
            locations.set(row.meeting_id, event.location);
            const email = (row.client_email as string).trim().toLowerCase();
            const attendee = event.attendees.find((a) => a.email.trim().toLowerCase() === email);
            if (attendee === undefined) continue;
            const response: AttendeeResponse = attendee.response;
            if (response === row.response) continue;
            const changed = await db.query(
              `UPDATE meetings SET response = $4, response_at = $5
                WHERE business_id = $1 AND meeting_id = $2 AND state = 'active' AND response = $3`,
              [businessId, row.meeting_id, row.response, response, now],
            );
            if ((changed.rowCount ?? 0) > 0) result.responsesChanged += 1;
          } catch {
            result.errored += 1;
          }
        }
      }
    }

    // 3. One alert per declined meeting, stamped before it is sent.
    const { rows: declined } = await db.query<ActiveRow>(
      `UPDATE meetings SET declined_notified_at = $2
        WHERE business_id = $1 AND state = 'active' AND response = 'declined'
          AND declined_notified_at IS NULL AND start_at > $2
        RETURNING meeting_id, calendar_id, event_id, client_name, client_email, start_at, response, updated_at`,
      [businessId, now],
    );
    for (const row of declined) {
      if (row.start_at === null) continue;
      const text = declinedAlertText(row.client_name, row.start_at.getTime(), tz);
      await alertOwner(owner, `❌ ${clean(row.client_name)} דחה פגישה`, text);
      result.declinedAlerts += 1;
    }

    // 4. Unanswered after the wait: claim, open a reminder, tell the owner once.
    let settings;
    try {
      settings = await loadMeetingSettings({ businessId });
    } catch {
      settings = null;
    }
    if (settings !== null) {
      const { rows: unanswered } = await db.query<ActiveRow>(
        `SELECT meeting_id, calendar_id, event_id, client_name, client_email, start_at, response, updated_at
           FROM meetings
          WHERE business_id = $1 AND state = 'active' AND response = 'needs_action'
            AND reminder_claimed_at IS NULL AND start_at > $2
          ORDER BY start_at, meeting_id`,
        [businessId, now],
      );
      for (const row of unanswered) {
        if (row.start_at === null) continue;
        const startMs = row.start_at.getTime();
        const waitMs = (startMs - now.getTime() < SOON_MS ? settings.reminderHoursSoon : settings.reminderHours) * HOUR_MS;
        if (now.getTime() - row.updated_at.getTime() < waitMs) continue;
        try {
          const claimed = await db.query(
            `UPDATE meetings SET reminder_claimed_at = $3
              WHERE business_id = $1 AND meeting_id = $2 AND reminder_claimed_at IS NULL
                AND state = 'active' AND response = 'needs_action'
              RETURNING meeting_id`,
            [businessId, row.meeting_id, now],
          );
          if ((claimed.rowCount ?? 0) === 0) continue;

          let outcome: 'opened' | ReminderSkip | 'open_failed';
          try {
            const opened = await openClientReminder({
              businessId,
              meetingId: row.meeting_id,
              ...(locations.has(row.meeting_id) ? { location: locations.get(row.meeting_id) ?? null } : {}),
            });
            outcome = 'jobId' in opened ? 'opened' : opened.skipped;
            if (outcome === 'opened') result.remindersOpened += 1;
          } catch {
            outcome = 'open_failed';
            result.errored += 1;
          }

          const stamped = await db.query(
            `UPDATE meetings SET unanswered_notified_at = $3
              WHERE business_id = $1 AND meeting_id = $2 AND unanswered_notified_at IS NULL
              RETURNING meeting_id`,
            [businessId, row.meeting_id, now],
          );
          if ((stamped.rowCount ?? 0) === 0) continue;
          const text = unansweredAlertText(row.client_name, startMs, tz, outcome);
          await alertOwner(owner, `⏳ ${clean(row.client_name)} עדיין לא אישר`, text);
          result.unansweredAlerts += 1;
        } catch {
          result.errored += 1;
        }
      }
    }
  }

  // 5. Holds whose question is over.
  try {
    const holds = await sweepHolds({
      businessId,
      runtime: o.runtime,
      ...(o.client ? { client: o.client } : {}),
    });
    result.holdsReleased = holds.released;
    result.errored += holds.failed;
  } catch {
    result.errored += 1;
  }
  return result;
}
