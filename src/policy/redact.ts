import type { PolicyBundle } from '../domain/policy.js';

/**
 * Apply the charter's redaction patterns to a payload on its way out.
 *
 * `charter.data.redactBeforeSending` compiled into the bundle and was read by
 * nobody: the gate returned the agent's raw input as `redactedInput`, so the
 * field named a protection that never ran.
 *
 * Strings only, recursively. Keys are left alone — a pattern that matched a key
 * would rename the field and change the payload's meaning, which is a different
 * and much more dangerous operation than blanking a value.
 */
export function redactPayload(input: unknown, bundle: PolicyBundle): unknown {
  if (bundle.redactPatterns.length === 0) return input;

  const patterns = compile(bundle.redactPatterns);
  if (patterns.length === 0) return input;

  return walk(input, patterns, 0);
}

const REDACTED = '[הוסר]';
/** Deep enough for any real payload; a guard against a cyclic structure. */
const MAX_DEPTH = 12;

function compile(sources: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const source of sources) {
    try {
      out.push(new RegExp(source, 'g'));
    } catch {
      // A charter carrying an invalid pattern must not take the gate down: a
      // send would then fail open on the *next* deploy, when someone removes
      // the throw to unblock themselves. Skipping one pattern is the smaller
      // failure, and the pattern is validated when the charter is signed.
      continue;
    }
  }
  return out;
}

function walk(value: unknown, patterns: RegExp[], depth: number): unknown {
  if (depth > MAX_DEPTH) return value;

  if (typeof value === 'string') {
    return patterns.reduce((text, pattern) => {
      pattern.lastIndex = 0;
      return text.replace(pattern, REDACTED);
    }, value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, patterns, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = walk(item, patterns, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Is `now` inside the charter's quiet hours, in the business's own timezone?
 *
 * The window wraps midnight in the normal case (22:00 → 07:00), which is why
 * the comparison is not a simple `from <= t < to`.
 */
export function inQuietHours(
  quietHours: PolicyBundle['quietHours'],
  now: Date,
): boolean {
  if (quietHours === null) return false;

  const local = localHourMinute(now, quietHours.timezone);
  const from = toMinutes(quietHours.from);
  const to = toMinutes(quietHours.to);
  if (from === null || to === null) return false;
  if (from === to) return false;

  return from < to
    ? local >= from && local < to
    : local >= from || local < to; // wraps midnight
}

function localHourMinute(now: Date, timezone: string): number {
  // Intl is the only correct way to do this without a tz database dependency,
  // and it is the only thing here that knows about DST.
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return hour * 60 + minute;
  } catch {
    // An unknown timezone must not silently disable the quiet-hours promise,
    // but it also must not crash a send. UTC is the honest fallback and the
    // charter schema is where a bad zone should have been caught.
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

function toMinutes(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}
