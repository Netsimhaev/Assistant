import type { DigestSettings } from '../governance/digest-settings.js';

export type DigestKind = 'daily' | 'weekly';

export interface DigestWindow {
  kind: DigestKind;
  /** Inclusive lower bound. */
  start: Date;
  /** The SCHEDULED moment this window closes at — never the send moment. */
  end: Date;
  /** How many scheduled windows this one absorbs. 1 is the ordinary case. */
  windowsCovered: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Which kinds each schedule includes — a positive table, never a negation. */
const KINDS_FOR_SCHEDULE: Readonly<Record<DigestSettings['schedule'], readonly DigestKind[]>> =
  Object.freeze({
    off: [],
    daily: ['daily'],
    weekly: ['weekly'],
    both: ['daily', 'weekly'],
  });

export function scheduledHourFor(settings: DigestSettings, kind: DigestKind): number {
  return kind === 'daily' ? settings.dailyHour : settings.weeklyHour;
}

/**
 * The parts of an instant as they read in a given IANA zone.
 *
 * `Intl` and not arithmetic on the UTC offset: the offset at a FUTURE or PAST
 * moment is exactly what daylight saving makes unsafe to assume, and this
 * codebase already learned that once — `nextTimeAt` in the quiet-hours path
 * probes forward in minutes rather than constructing a local date, for the same
 * reason and with the same note.
 */
function partsIn(at: Date, timeZone: string): { hour: number; weekday: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', weekday: 'short',
  });
  const parts = new Map(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    hour: Number(parts.get('hour') ?? '0'),
    weekday: weekdays.indexOf(parts.get('weekday') ?? 'Sun'),
    ymd: `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`,
  };
}

/**
 * TODAY's (or, for weekly, THIS WEEK's) scheduled moment, in the charter's
 * zone — or `null` when it hasn't arrived yet.
 *
 * Deliberately NOT "the most recent scheduled moment at or before `now`,
 * however many days back that takes": probed without that gate, a check at
 * 07:30 for an 08:00 daily schedule finds *yesterday's* 08:00 and reports it
 * as due, even though today's hour never arrived — the schedule would be
 * reporting itself before its own hour struck. "Nothing is due before the
 * scheduled hour has passed" (spec §5) is a per-day rule, not a per-history
 * one: it holds the same way whether this is the first digest ever or the
 * fiftieth. So weekday and hour are checked against `now` itself first; only
 * once that passes do we probe for the exact top of the hour.
 *
 * The probe steps backwards an hour at a time rather than constructing a
 * local timestamp from a UTC offset — the same approach, and the same
 * reason, as `partsIn` above and as `nextTimeAt` in the quiet-hours path:
 * the offset at a past or future moment is exactly what daylight saving
 * makes unsafe to assume. Bounded to one day of hours, since the gate above
 * already established the wanted hour falls on `now`'s calendar day; the
 * loop's own `ymd` check is a second, independent guard against drifting
 * into the previous day on a zone/DST quirk that skips the wanted hour
 * entirely (it returns null rather than silently reporting yesterday's).
 */
function lastScheduledMoment(
  settings: DigestSettings,
  kind: DigestKind,
  now: Date,
  timeZone: string,
): Date | null {
  const wantedHour = scheduledHourFor(settings, kind);
  const nowParts = partsIn(now, timeZone);

  if (kind === 'weekly' && nowParts.weekday !== settings.weeklyDay) return null;
  if (nowParts.hour < wantedHour) return null;

  for (let back = 0; back <= 25; back += 1) {
    const candidate = new Date(now.getTime() - back * 60 * 60 * 1000);
    const parts = partsIn(candidate, timeZone);
    if (parts.ymd !== nowParts.ymd) return null;
    if (parts.hour !== wantedHour) continue;
    // Truncate to the top of that hour: the schedule is hour-granular (spec §4).
    return new Date(candidate.getTime() - candidate.getTime() % (60 * 60 * 1000));
  }
  return null;
}

/**
 * The window this kind owes the owner right now, or `null` when it owes none.
 *
 * **`end` is the SCHEDULED moment and never `now`** — spec §5. A pass that runs
 * late still reports the window that closed on the hour; anchoring to the send
 * moment would drag every later window forward until they overlap, and the
 * digest's own claim about its period would stop being checkable against the
 * stored row.
 *
 * **Several missed windows of one kind collapse into one** that carries
 * `windowsCovered > 1`, which the renderer turns into a sentence admitting the
 * gap. Spec §5: three retroactive dailies at once are noise.
 *
 * **Gap merging never crosses kinds.** This function is called once per kind
 * and knows nothing about the other, which is what keeps the weekly from
 * swallowing missed dailies — they answer two different questions, and the
 * overlap between them is deliberate.
 */
export function dueWindow(
  settings: DigestSettings,
  kind: DigestKind,
  lastSentEnd: Date | null,
  now: Date,
  timeZone: string,
): DigestWindow | null {
  if (!KINDS_FOR_SCHEDULE[settings.schedule].includes(kind)) return null;

  const end = lastScheduledMoment(settings, kind, now, timeZone);
  if (end === null) return null;
  if (lastSentEnd !== null && lastSentEnd.getTime() >= end.getTime()) return null;

  const span = kind === 'daily' ? DAY_MS : WEEK_MS;
  const start = lastSentEnd === null ? new Date(end.getTime() - span) : lastSentEnd;
  const covered = Math.max(1, Math.round((end.getTime() - start.getTime()) / span));

  return { kind, start, end, windowsCovered: covered };
}
