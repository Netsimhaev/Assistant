import type { Weekday } from '../domain/charter.js';

const WEEKDAYS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;

interface Wall {
  date: string;
  time: string;
  weekday: Weekday;
  /** The wall-clock reading expressed as if it were UTC, in ms. Monotone in the instant except at DST fall-back. */
  wallMs: number;
}

/** Wall-clock reading of `at` in `timeZone`, via Intl (never offset arithmetic). */
function wallOf(at: Date, timeZone: string): Wall {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p = new Map(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const hour = p.get('hour') === '24' ? '00' : (p.get('hour') ?? '00');
  const date = `${p.get('year')}-${p.get('month')}-${p.get('day')}`;
  const time = `${hour}:${p.get('minute')}`;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekday = WEEKDAYS[names.indexOf(p.get('weekday') ?? 'Sun')] ?? 'sun';
  const wallMs = Date.UTC(
    Number(p.get('year')), Number(p.get('month')) - 1, Number(p.get('day')),
    Number(hour), Number(p.get('minute')), Number(p.get('second')),
  );
  return { date, time, weekday, wallMs };
}

export function localParts(instant: Date, timeZone: string): { date: string; time: string; weekday: Weekday } {
  const { date, time, weekday } = wallOf(instant, timeZone);
  return { date, time, weekday };
}

/**
 * The instant at which the wall clock in `timeZone` reads `date` `time`.
 *
 * Found by probing: the zone's offset is sampled (via Intl) a day either side of
 * the wall-clock-as-UTC guess, each sample proposes a candidate, and a candidate
 * counts only if the zone really reads the requested wall time at it. Nothing is
 * assumed about the offset at the target moment.
 *
 * DST fall-back (the wall time occurs twice): the EARLIER instant is returned.
 * Either one round-trips through `localParts` to the same local date.
 *
 * DST spring-forward (the wall time never occurs): resolves to the first valid
 * minute after it (e.g. 02:30 in a 02:00->03:00 gap gives 03:00). Never throws.
 */
export function localToInstant(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const target = Date.UTC(y, mo - 1, d, h, mi, 0);

  const offsets = new Set<number>();
  for (const probe of [target - DAY_MS, target, target + DAY_MS]) {
    offsets.add(wallOf(new Date(probe), timeZone).wallMs - probe);
  }
  const hits: number[] = [];
  for (const off of offsets) {
    const candidate = target - off;
    if (wallOf(new Date(candidate), timeZone).wallMs === target) hits.push(candidate);
  }
  if (hits.length > 0) return new Date(Math.min(...hits));

  // Gap: start from the earliest proposal (reads before the target) and walk
  // forward minute by minute to the first instant whose wall time has reached it.
  let at = Math.min(...[...offsets].map((off) => target - off));
  for (let i = 0; i < 24 * 60; i += 1) {
    if (wallOf(new Date(at), timeZone).wallMs >= target) return new Date(at);
    at += MIN_MS;
  }
  return new Date(at);
}

function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

function weekdayOfDate(date: string): Weekday {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()] ?? 'sun';
}

/**
 * `n` business days after `from`'s local date, skipping days not in `workweek`
 * and dates in `holidays`; returns the instant at `hour`:00 local.
 */
export function addBusinessDays(
  from: Date,
  n: number,
  opts: { timeZone: string; workweek: Weekday[]; holidays: string[]; hour: number },
): Date {
  let date = localParts(from, opts.timeZone).date;
  let counted = 0;
  // Bound guards against an empty workweek looping forever.
  for (let i = 0; counted < n && i < 3660; i += 1) {
    date = addDays(date, 1);
    if (opts.workweek.includes(weekdayOfDate(date)) && !opts.holidays.includes(date)) counted += 1;
  }
  const hh = String(opts.hour).padStart(2, '0');
  return localToInstant(date, `${hh}:00`, opts.timeZone);
}
