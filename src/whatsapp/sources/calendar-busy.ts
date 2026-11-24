/**
 * Busy / free for the window the sender asked about. Never "free" by default:
 * no window, an unreadable window, a failed read or a truncated read means the
 * source does not answer. Event titles are third-party text and appear only
 * when an overlapping event is linked to THIS sender through a `meetings` row.
 */
import { resolveCalendarAccess } from '../../calendar/client-for.js';
import { isCalendarFailure, type CalendarClient } from '../../calendar/types.js';
import { busyIntervals } from '../../meetings/free-time.js';
import { loadMeetingSettings } from '../../meetings/settings.js';
import { loadCalendarRange } from '../../meetings/snapshot.js';
import type { Runtime } from '../../orchestrator/runtime.js';
import { stripBidiControls, toOneLine } from '../../util/bidi.js';
import { localParts } from '../../util/local-time.js';
import type { Tier2Source } from './types.js';

const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const EMPTY = { items: [], ownershipViolation: false } as const;
const FAILED = { items: [], ownershipViolation: false, failed: true } as const;

export function createCalendarBusySource(deps: {
  runtime: Pick<Runtime, 'credentials'>;
  client?: CalendarClient;
}): Tier2Source {
  return async (db, ids, signal, ctx) => {
    const w = ctx.window;
    if (w === null) return { ...EMPTY, items: [] };
    const from = w.from.getTime();
    const to = w.to.getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_WINDOW_MS) {
      return { ...FAILED, items: [] };
    }

    const access = await resolveCalendarAccess(db, {
      runtime: deps.runtime,
      ...(deps.client !== undefined ? { client: deps.client } : {}),
    });
    if ('unavailable' in access) return { ...FAILED, items: [] };
    const settings = await loadMeetingSettings(db);
    const snap = await loadCalendarRange(db, {
      access,
      settings,
      timeZone: ctx.timeZone,
      fromIso: w.from.toISOString(),
      toIso: w.to.toISOString(),
      signal,
    });
    if (isCalendarFailure(snap) || snap.truncated) return { ...FAILED, items: [] };

    const busy = busyIntervals(snap, 0).some((i) => i.start < to && i.end > from);
    const f = localParts(w.from, ctx.timeZone);
    const t = localParts(w.to, ctx.timeZone);
    let text = `${f.date} ${f.time}–${t.date === f.date ? '' : `${t.date} `}${t.time}: ${busy ? 'תפוס' : 'פנוי'}`;

    if (busy) {
      const overlapping = snap.events
        .filter((e) => e.busy && !e.selfDeclined && Date.parse(e.start) < to && Date.parse(e.end) > from)
        .map((e) => e.eventId);
      if (overlapping.length > 0) {
        const { rows } = await db.query<{ event_id: string }>(
          `SELECT event_id FROM meetings
            WHERE business_id = $1 AND event_id = ANY($2::text[])
              AND ( (client_phone IS NOT NULL AND regexp_replace(client_phone, '\\D', '', 'g') = $3)
                 OR ($4::text IS NOT NULL AND client_email IS NOT NULL AND lower(client_email) = lower($4)) )`,
          [db.businessId, overlapping, ids.key, ids.email],
        );
        const linked = new Set(rows.map((r) => r.event_id));
        const ev = snap.events.find((e) => linked.has(e.eventId));
        if (ev !== undefined) {
          const title = toOneLine(stripBidiControls(ev.title));
          if (title !== '') text += ` — ${title}`;
        }
      }
    }
    return { items: [{ source: 'calendar_busy', label: 'יומן', text, documentId: null, at: null }], ownershipViolation: false };
  };
}
