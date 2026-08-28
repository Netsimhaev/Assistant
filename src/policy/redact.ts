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

/**
 * Exported so `src/orchestrator/adapters/mail.ts` can refuse this exact
 * placeholder as a recipient: a redacted payload that still carries `to:
 * '[הוסר]'` must never resolve to an address rather than being sent nowhere.
 */
export const REDACTED = '[הוסר]';
/** Deep enough for any real payload; a guard against a cyclic structure. */
const MAX_DEPTH = 12;

function compile(sources: readonly string[]): RegExp[] {
  // Throws rather than skipping. The skipping form was justified by "the
  // pattern is validated when the charter is signed" — which was not true at
  // the time, so a typo disabled a signed redaction silently and forever. It
  // is true now (`CharterData.redactBeforeSending` compiles each pattern), so
  // reaching this throw means the bundle was built by something that bypassed
  // the schema, and failing loudly is right. Both callers fail closed.
  return sources.map((source) => new RegExp(source, 'g'));
}

function walk(value: unknown, patterns: RegExp[], depth: number): unknown {
  // Redacted rather than returned as-is: a value we declined to inspect is not
  // a value we have cleared for sending.
  if (depth > MAX_DEPTH) return REDACTED;

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
      // `defineProperty`, never `out[key] = …`. `JSON.parse` makes `__proto__`
      // an ordinary own property, and plain assignment to that name invokes
      // the inherited setter instead: the copy loses the key and gains a
      // prototype. The gate then screens the original — where `to` is nested
      // inside the `__proto__` value and invisible — while the adapter reads
      // the copy, where a plain `input['to']` lookup walks the prototype and
      // finds a real address. Same key, two different answers, and the one
      // that decides is not the one that sends. `defineProperty` writes an own
      // data property for every key, `__proto__` included, which also keeps
      // this function's promise that keys are left exactly as they came.
      Object.defineProperty(out, key, {
        value: walk(item, patterns, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
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
  // Unparseable means we cannot tell, and the owner signed a promise. The
  // restrictive answer is the honest one; the schema rejects these shapes at
  // signing, so reaching either branch means something bypassed it.
  if (from === null || to === null) return true;
  // A zero-width window is not "never quiet" — the charter says the window
  // exists, and a window we cannot make sense of should not silently vanish
  // from a document the owner still reads as a promise.
  if (from === to) return true;

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
    // Falling back to UTC does not widen the window, it *shifts* it: 22:30 in
    // Jerusalem is 19:30 UTC, outside a 22:00-07:00 window, so the message the
    // owner promised would not be sent went out. The zone is validated when the
    // charter is signed, so this is now unreachable — and if something does
    // reach it, refusing to send is the side to fail on.
    throw new Error(`unresolvable time zone "${timezone}"`);
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
