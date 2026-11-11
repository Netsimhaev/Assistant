/**
 * Attendee-less holds (calendar scheduling, spec §7.2, owner ruling M23): a
 * placeholder written to the owner's own calendar BEFORE he confirms a
 * meeting, so the slot is not given away while the question is open.
 *
 * This is the ONE documented gate bypass of the feature. It is safe because
 * of what it cannot do, and each limit is locked by `holds-invariants.test.ts`:
 *   - the write never carries an attendee (`attendees: []`), so nobody is
 *     invited or notified;
 *   - it writes only the write calendar the caller names, and the title always
 *     starts with `HOLD_TITLE_PREFIX` — the only form the calendar adapter
 *     will later convert into a real meeting;
 *   - it deletes only an event id found in `meeting_holds` in state `held`,
 *     i.e. something this module created;
 *   - the audit row carries a hash of calendar and times, never the name;
 *   - the client uses `createEvent` and `deleteEvent` only.
 * Only `door.ts` and `sync.ts` may import `createHold`/`releaseHold`.
 */
import { ulid } from 'ulid';
import { appendAudit } from '../audit/log.js';
import { HOLD_TITLE_PREFIX } from '../calendar/calendar.js';
import { resolveCalendarAccess, type CalendarAccess } from '../calendar/client-for.js';
import { isCalendarFailure, type CalendarClient, type CalendarFailure } from '../calendar/types.js';
import { config } from '../config.js';
import type { BusinessDb } from '../db/pool.js';
import type { Runtime } from '../orchestrator/runtime.js';
import { stripBidiControls, toOneLine } from '../util/bidi.js';
import { canonicalHash } from '../util/canonical.js';

export { HOLD_TITLE_PREFIX };

const HOLD_DESCRIPTION = 'שמירת מקום של העוזרת — ממתינה לאישור שלך.';
const MAX_TITLE_CHARS = 300;
/** A hold older than the question window plus this margin is released regardless. */
const HOLD_GRACE_MINUTES = 15;
/**
 * A hold whose job is in `plan` with no pending question yet is released only
 * past this age. The door moves the job to `plan` and binds the plan before
 * `askAndPark` writes the pending row, so a sweep in another process inside
 * that gap would otherwise release a hold the owner is about to confirm.
 */
const NO_QUESTION_GRACE_MINUTES = 5;
const SWEEP_CALL_TIMEOUT_MS = 30_000;

interface HoldRow {
  hold_id: string;
  business_id: string;
  job_id: string;
  calendar_id: string;
  event_id: string;
  start_at: Date;
  end_at: Date;
  state: string;
}

async function auditHold(db: BusinessDb, o: {
  jobId: string;
  event: 'created' | 'released';
  calendarId: string;
  start: string;
  end: string;
}): Promise<void> {
  const { rows } = await db.query<{ charter_version: string }>(
    'SELECT charter_version FROM jobs WHERE job_id = $1 AND business_id = $2',
    [o.jobId, db.businessId],
  );
  // Calendar, times and the event kind only: never the client's name. The kind
  // is 'tool_call' because `AuditKind` is a closed enum and a new kind would
  // change the audit schema for one feature; `reason` carries the distinction.
  await appendAudit(
    db,
    {
      jobId: o.jobId,
      actor: 'sched.meetings',
      kind: 'tool_call',
      reason: `calendar_hold:${o.event}`,
      inputHash: canonicalHash({ calendarId: o.calendarId, start: o.start, end: o.end }),
      provenance: 'boss',
      charterVersion: rows[0]?.charter_version ?? 'n/a',
      envelopeId: null,
      onBehalfOf: null,
      actionClass: null,
      risk: null,
      outputHash: null,
      artifacts: [],
      costMinor: null,
      tokens: null,
    }
  );
}

export async function createHold(db: BusinessDb, o: {
  access: CalendarAccess;
  jobId: string;
  calendarId: string;
  start: string;
  end: string;
  clientName: string;
  signal: AbortSignal;
}): Promise<{ holdId: string; eventId: string } | CalendarFailure> {
  const name = toOneLine(stripBidiControls(o.clientName));
  const title = `${HOLD_TITLE_PREFIX}${name}`.slice(0, MAX_TITLE_CHARS);
  // Each hold owns its event: a key derived from the job alone would hand a
  // second hold of the same job the FIRST event's id.
  const holdId = `H-${ulid()}`;
  const created = await o.access.client.createEvent(
    o.access.token,
    o.calendarId,
    {
      title,
      start: o.start,
      end: o.end,
      location: null,
      description: HOLD_DESCRIPTION,
      attendees: [],
    },
    `hold:${holdId}`,
    o.signal,
  );
  if (isCalendarFailure(created)) return created;

  try {
    await db.query(
      `INSERT INTO meeting_holds (hold_id, business_id, job_id, calendar_id, event_id, start_at, end_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [holdId, db.businessId, o.jobId, o.calendarId, created.eventId, o.start, o.end],
    );
  } catch (error) {
    // An event nobody records is an event nobody can release: take it back —
    // but only when no row references it. A provider that answers a replayed
    // key with an existing id must not get that other row's event deleted.
    try {
      const { rows: owners } = await db.query(
        'SELECT 1 FROM meeting_holds WHERE business_id = $1 AND calendar_id = $2 AND event_id = $3',
        [db.businessId, o.calendarId, created.eventId],
      );
      if (owners.length === 0) {
        await o.access.client.deleteEvent(o.access.token, o.calendarId, created.eventId, o.signal);
      }
    } catch {
      // best effort; the original error is what matters
    }
    throw error;
  }
  await auditHold(db, {
    jobId: o.jobId,
    event: 'created',
    calendarId: o.calendarId,
    start: o.start,
    end: o.end,
  });
  return { holdId, eventId: created.eventId };
}

export async function releaseHold(db: BusinessDb, o: {
  access: CalendarAccess;
  holdId: string;
  signal: AbortSignal;
}): Promise<'released' | 'already' | CalendarFailure> {
  // Claim first: only one caller proceeds to the provider, and the row can no
  // longer be taken for a live hold by anyone else while we work.
  const { rows } = await db.query<HoldRow>(
    `UPDATE meeting_holds SET state = 'released'
      WHERE business_id = $1 AND hold_id = $2 AND state = 'held'
      RETURNING *`,
    [db.businessId, o.holdId],
  );
  const hold = rows[0];
  if (hold === undefined) {
    const { rows: existing } = await db.query(
      'SELECT 1 FROM meeting_holds WHERE business_id = $1 AND hold_id = $2',
      [db.businessId, o.holdId],
    );
    if (existing.length === 0) {
      return { failure: 'rejected', status: 0, message: 'no such hold: refusing to delete an event this module did not create' };
    }
    return 'already';
  }
  const setState = async (state: 'held' | 'converted'): Promise<void> => {
    await db.query(
      'UPDATE meeting_holds SET state = $3 WHERE business_id = $1 AND hold_id = $2',
      [db.businessId, o.holdId, state],
    );
  };

  // The adapter may have turned the placeholder into a real meeting with
  // attendees since we last looked; deleting it then would cancel that meeting.
  // The time zone only affects rendering, which this check does not use.
  const current = await o.access.client.getEvent(o.access.token, hold.calendar_id, hold.event_id, 'UTC', o.signal);
  if (isCalendarFailure(current)) {
    if (current.failure !== 'not_found') {
      await setState('held');
      return current;
    }
    // Already gone: nothing to delete.
  } else if (!current.organizerIsSelf || current.attendees.length > 0 || !current.title.startsWith(HOLD_TITLE_PREFIX)) {
    await setState('converted');
    return 'already';
  } else {
    const deleted = await o.access.client.deleteEvent(o.access.token, hold.calendar_id, hold.event_id, o.signal);
    // Already gone at the provider counts as released.
    if (isCalendarFailure(deleted) && deleted.failure !== 'not_found') {
      await setState('held');
      return deleted;
    }
  }
  await auditHold(db, {
    jobId: hold.job_id,
    event: 'released',
    calendarId: hold.calendar_id,
    start: hold.start_at.toISOString(),
    end: hold.end_at.toISOString(),
  });
  return 'released';
}

/** The meeting step took over the placeholder: it is now the meeting, not a hold. */
export async function markHoldConverted(db: BusinessDb, o: {
  calendarId: string;
  eventId: string;
}): Promise<void> {
  await db.query(
    `UPDATE meeting_holds SET state = 'converted'
      WHERE business_id = $1 AND calendar_id = $2 AND event_id = $3 AND state = 'held'`,
    [db.businessId, o.calendarId, o.eventId],
  );
}

export async function sweepHolds(db: BusinessDb, o: {
  runtime: Pick<Runtime, 'credentials'>;
  client?: CalendarClient;
}): Promise<{ released: number; failed: number }> {
  const { rows } = await db.query<{ hold_id: string }>(
    `SELECT h.hold_id
       FROM meeting_holds h
       LEFT JOIN jobs j ON j.job_id = h.job_id AND j.business_id = h.business_id
      WHERE h.business_id = $1 AND h.state = 'held'
        AND (
          j.job_id IS NULL
          OR j.phase IN ('closed', 'failed')
          OR (
            -- Only a job still asking may lose its hold, and never one whose
            -- question was answered yes (execute, verify, remember, followup,
            -- await_approval and every other phase keep theirs).
            j.phase = 'plan'
            AND NOT EXISTS (
              SELECT 1 FROM instruction_confirmations c
               WHERE c.business_id = h.business_id AND c.job_id = h.job_id AND c.state = 'confirmed'
            )
            AND (
              (
                NOT EXISTS (
                  SELECT 1 FROM instruction_confirmations c
                   WHERE c.business_id = h.business_id AND c.job_id = h.job_id AND c.state = 'pending'
                )
                AND h.created_at < now() - make_interval(mins => $3::int)
              )
              OR h.created_at < now() - make_interval(mins => $2::int)
            )
          )
        )`,
    [db.businessId, config.whatsappQuestionWindowMinutes + HOLD_GRACE_MINUTES, NO_QUESTION_GRACE_MINUTES],
  );
  if (rows.length === 0) return { released: 0, failed: 0 };

  const access = await resolveCalendarAccess(db, {
    runtime: o.runtime,
    ...(o.client ? { client: o.client } : {}),
  });
  if ('unavailable' in access) return { released: 0, failed: rows.length };

  let released = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await releaseHold(db, {
        access,
        holdId: row.hold_id,
        signal: AbortSignal.timeout(SWEEP_CALL_TIMEOUT_MS),
      });
      if (result === 'released') released += 1;
      else if (result !== 'already') failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { released, failed };
}
