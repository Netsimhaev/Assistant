/**
 * The scheduled time of an owner-ordered WhatsApp message (`wa.send_message`'s
 * `sendAt`), read one way everywhere: the instruction door's plan check, the
 * confirmation echo, `executeStep`'s deferral, the confirmed-command exemption
 * and the re-ask.
 *
 * Strict on purpose. Only a full ISO-8601 instant with an explicit offset
 * (`Z` or `±hh:mm`) is a time: a wall-clock time with no offset means a
 * different instant on every machine, and `Date.parse` alone rolls
 * `2026-02-30` over into March. Anything that does not parse is `null` —
 * never "now", never a default — and every caller treats `null` as the
 * restrictive answer (refused at plan time, no extension in the exemption).
 */

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** Scheduled sends may be at most this far ahead (global constraints, H15). */
export const MAX_SEND_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

export function parseIsoInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = ISO_INSTANT.exec(value);
  if (m === null) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [
    number, number, number, number, number,
  ];
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  // The calendar day must exist: Date.UTC rolls an impossible one over.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  if (m[8] !== undefined && (Number(m[8]) > 14 || Number(m[9]) > 59)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Whether the payload carries a `sendAt` of its own (an own property, never inherited). */
export function hasSendAt(input: Record<string, unknown>): boolean {
  return Object.hasOwn(input, 'sendAt');
}

/** The payload's own `sendAt` as an instant, or `null` when absent or unparsable. */
export function readSendAt(input: Record<string, unknown>): Date | null {
  if (!hasSendAt(input)) return null;
  return parseIsoInstant(input['sendAt']);
}
