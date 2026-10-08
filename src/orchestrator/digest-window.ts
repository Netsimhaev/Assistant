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

/** Exported so a caller needing the same span (the dashboard's weekly live
 * preview, fix round 2 item 6) does not restate the magic number. */
export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

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
function partsIn(
  at: Date,
  timeZone: string,
): { hour: number; minute: number; second: number; weekday: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const parts = new Map(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    hour: Number(parts.get('hour') ?? '0'),
    minute: Number(parts.get('minute') ?? '0'),
    second: Number(parts.get('second') ?? '0'),
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
 *
 * Three edge cases below were resolved by measuring this function against
 * real zones, not by reasoning about them in the abstract — each is stated
 * here so a future reader doesn't "fix" a deliberate choice back into a bug.
 *
 * **A weekly is only ever found due on its scheduled weekday — never on a
 * later day that merely remembers the gap.** The weekday gate above means a
 * process that is down for the entirety of its scheduled weekday will not
 * report that week's window on Monday, Tuesday, or any other day; it waits
 * for the *next* occurrence of the scheduled weekday, however large the
 * backlog. This is a real narrowing relative to scanning each candidate's
 * own weekday over, say, the last 8 days — that wider scan would let a
 * Wednesday poll find a missed Sunday. It is safe here only because the
 * merge in `dueWindow` absorbs the delay rather than losing it: when the
 * scheduled weekday does come back around, `start` is still the stale
 * `lastSentEnd` and `windowsCovered` comes out 2 (or more), so the gap is
 * reported, not dropped — just discovered up to 7 days later than the
 * widest possible scan would have discovered it. Do not restore the
 * per-candidate weekday scan thinking it closes a hole; it would reopen the
 * "weekly swallows missed dailies" risk this module's gap-merging is
 * designed to avoid, since a multi-day scan has no natural boundary to stop
 * at other than the one the weekday gate already gives it for free.
 *
 * **DST fall-back (the clock repeats an hour): the probe finds the LATER of
 * the two occurrences of the wanted hour, and that is correct.** "The most
 * recently elapsed instance of this hour" is, by construction, the second
 * time the clock reads that hour that day — probing backward from `now`
 * reaches it first. Verified against `America/New_York` on 2026-11-01
 * (clocks fall back from 2am EDT to 1am EST) with `wantedHour: 1`: `end`
 * comes out `2026-11-01T06:00:00.000Z`, which is 01:00 EST — the second
 * 1am, not the first.
 *
 * **DST spring-forward (the clock skips an hour): if the wanted hour never
 * occurs that day, this returns `null` for that day, and the next day
 * resolves normally.** The `ymd` guard in the loop is what produces this:
 * it can never find a match for the skipped hour before crossing into the
 * previous calendar day, so it falls through to `null` rather than
 * reporting a neighboring hour that was never actually scheduled. The skip
 * is absorbed the same way any other missed day is — by `windowsCovered`
 * being larger than 1 on the next occurrence that does fire. Verified
 * against `America/New_York` on 2026-03-08 (clocks spring forward from
 * 1:59am to 3:00am) with `wantedHour: 2`, checked just after the skip
 * (03:30 local): without the `ymd` guard the probe's 25-hour bound reaches
 * all the way back to YESTERDAY's valid 2am, so the guard is load-bearing
 * here, not decorative — it breaks out before that match and the function
 * returns `null`.
 */
/**
 * The most recent occurrence of `hour` (local to `timeZone`) at or before
 * `now`, truncated to the top of that hour — or `null` if none is found
 * within `maxHoursBack`.
 *
 * **This is the shared Intl probe-and-truncate rule, and it has exactly one
 * home.** It used to be inlined inside `lastScheduledMoment` below; the
 * dashboard's digest screen (`dashboard/server.ts`) needed the identical
 * rule for its "today so far" live preview and, for a while, carried a
 * second copy of it. A rule this codebase deliberately keeps in one place —
 * probing via `Intl.DateTimeFormat` rather than UTC-offset arithmetic (the
 * offset at a past moment is exactly what daylight saving makes unsafe to
 * assume), and truncating by subtracting the zone's own reported minutes and
 * seconds rather than `% 3_600_000` (which only lands on the local hour
 * boundary when the zone's offset is a whole number of hours — `Asia/Kolkata`
 * at UTC+5:30 is not) — does not get a second owner. This export, and the 12
 * tests on `dueWindow` in `digest-window.test.ts` that exercise it through
 * `lastScheduledMoment`, are its only coverage; the dashboard inherits that
 * coverage by calling this function rather than re-deriving the rule.
 *
 * **Deliberately NOT gated to "today".** `lastScheduledMoment`'s own
 * "hasn't struck yet today → null" and "crossed into yesterday → null" rules
 * are a day-boundary policy specific to a window that gets STORED and
 * compared against the last one sent — they do not belong in the shared
 * primitive, because the dashboard's live preview wants the opposite: "the
 * last boundary, whatever day it falls on", since nothing it computes is
 * ever written down or merged with a prior window. `lastScheduledMoment`
 * below adds that gate back on top of this function; this function itself
 * only ever answers "where is the nearest matching hour going backward".
 */
export function lastHourInstant(
  hour: number,
  timeZone: string,
  now: Date,
  maxHoursBack = 24 * 8,
): Date | null {
  for (let back = 0; back <= maxHoursBack; back += 1) {
    const candidate = new Date(now.getTime() - back * 60 * 60 * 1000);
    const parts = partsIn(candidate, timeZone);
    if (parts.hour !== hour) continue;
    const subSecondMs = candidate.getTime() % 1000;
    return new Date(candidate.getTime() - parts.minute * 60_000 - parts.second * 1000 - subSecondMs);
  }
  return null;
}

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

  // Bounded to 25 hours back, same as the inlined loop this replaced: the
  // gate above already guarantees TODAY's occurrence of `wantedHour` exists
  // within the last 24 hours when it exists at all, so 25 is enough to reach
  // it and not so large that it would silently also reach into yesterday
  // undetected — the `ymd` check right below is what actually rejects
  // yesterday's match; the bound is just not wasteful about finding it.
  const found = lastHourInstant(wantedHour, timeZone, now, 25);
  if (found === null) return null;

  // The day-boundary gate `lastHourInstant` itself does not have (see its own
  // docblock): a match that landed on a different calendar day than `now` is
  // the DST spring-forward case (today's hour was skipped; the probe reached
  // back into yesterday's valid occurrence instead) and must not be reported
  // as today's window.
  if (partsIn(found, timeZone).ymd !== nowParts.ymd) return null;
  return found;
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
