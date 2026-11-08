/**
 * The assistant's own record of the meetings it proposes (migration 061,
 * `meetings`). One row per planned change, keyed `(business_id, job_id,
 * step_id)`, written in state `proposed` when the owner is asked. The row is
 * where the internal note lives — it never reaches a step input — and where the
 * client's response is tracked later.
 *
 * Idempotent: a second call for the same job and steps writes nothing
 * (`ON CONFLICT DO NOTHING`), so a retried door does not duplicate rows.
 */
import { ulid } from 'ulid';
import { getPool, type Queryable } from '../db/pool.js';
import type { Plan } from '../domain/plan.js';
import type { PlannedChange } from './plan.js';

export async function recordProposedMeetings(o: {
  businessId: string;
  jobId: string;
  plan: Plan;
  changes: PlannedChange[];
  db?: Queryable;
}): Promise<void> {
  if (o.changes.length !== o.plan.steps.length) {
    throw new Error('recordProposedMeetings: one change per plan step is required');
  }
  if (o.changes.length === 0) return;

  const values: unknown[] = [];
  const rows: string[] = [];
  for (const [i, change] of o.changes.entries()) {
    const step = o.plan.steps[i] as Plan['steps'][number];
    let calendarId: string;
    let eventId: string | null;
    let start: string;
    let end: string;
    let internalNote: string | null = null;
    let notified: boolean;
    if (change.op === 'create') {
      calendarId = change.calendarId;
      const hold = step.input['holdEventId'];
      eventId = typeof hold === 'string' && hold !== '' ? hold : null;
      start = change.start;
      end = change.end;
      internalNote = change.internalNote;
      notified = change.client.email !== null;
    } else {
      calendarId = change.event.calendarId;
      eventId = change.event.eventId;
      start = change.start ?? change.event.start;
      end = change.end ?? change.event.end;
      notified = change.event.attendees.length > 0;
    }
    const base = values.length;
    values.push(
      `M-${ulid()}`,
      o.businessId,
      o.jobId,
      step.id,
      calendarId,
      eventId,
      change.op,
      change.client.name,
      change.client.email,
      change.client.emailVerified,
      change.client.phone,
      internalNote,
      start,
      end,
      notified ? 'needs_action' : 'not_updated',
    );
    rows.push(`(${Array.from({ length: 15 }, (_, k) => `$${base + k + 1}`).join(', ')}, 'proposed')`);
  }

  await (o.db ?? getPool()).query(
    `INSERT INTO meetings (meeting_id, business_id, job_id, step_id, calendar_id, event_id, operation,
        client_name, client_email, client_email_verified, client_phone, internal_note, start_at, end_at,
        response, state)
     VALUES ${rows.join(', ')}
     ON CONFLICT (business_id, job_id, step_id) DO NOTHING`,
    values,
  );
}
