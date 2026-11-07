/**
 * The charter amendment that connects the business's one calendar (Google
 * Calendar / Microsoft 365) for reading AND writing.
 *
 * Same shape as `amend-mailbox.ts`: one fixed change, so what the owner sees on
 * the sign page and what is hashed are the same small diff.
 *
 *   1. a `calendar` connection is added, serving `calendar.read` and
 *      `calendar.write`;
 *   2. the calendar tools are removed from every other connection, and a
 *      connection left serving nothing is dropped (`office-calendar`, the
 *      legacy read-only one);
 *   3. the provider's subprocessor is named on the connection and added to
 *      `data.subprocessorsAllowed` if absent;
 *   4. a new `charterVersion`, `effectiveFrom` now, `supersedes` the active one.
 *
 * Every other field is copied verbatim (`amend-calendar.test.ts`).
 */
import { ulid } from 'ulid';
import { CALENDAR_SYSTEM } from '../calendar/calendar.js';
import type { CalendarProvider } from '../calendar/calendar.js';
import type { BusinessCharter, UnsignedCharter } from '../domain/charter.js';
import type { CharterConnection } from '../domain/connection.js';

/** The subprocessor identifier the signed charter names for each provider (same strings as the mailbox). */
export const CALENDAR_SUBPROCESSOR: Readonly<Record<CalendarProvider, string>> = {
  google: 'google-workspace',
  microsoft: 'microsoft-365',
};

/** The owner-facing name of the connection, as it appears in the signed charter. */
export const CALENDAR_CONNECTION_LABEL = 'יומן העסק';

/** The tools the calendar connection takes over from every other connection. */
const CALENDAR_TOOLS: readonly string[] = ['calendar.read', 'calendar.write', 'calendar.propose_slots'];
const CALENDAR_SERVES = ['calendar.read', 'calendar.write'];

export class CalendarAlreadyDeclaredError extends Error {
  constructor(charterVersion: string) {
    super(`charter ${charterVersion} already declares a "${CALENDAR_SYSTEM}" connection; refusing to add a second`);
    this.name = 'CalendarAlreadyDeclaredError';
  }
}

export class NoCalendarToRevertError extends Error {
  constructor(charterVersion: string) {
    super(`charter ${charterVersion} declares no "${CALENDAR_SYSTEM}" connection; nothing to revert`);
    this.name = 'NoCalendarToRevertError';
  }
}

/** The diff the sign page renders: system names of connections dropped / narrowed. */
export interface CalendarAmendmentDiff {
  readonly dropped: string[];
  readonly narrowed: string[];
  readonly subprocessorAdded: boolean;
}

function servesCalendar(c: CharterConnection): boolean {
  return c.serves.some((tool) => CALENDAR_TOOLS.includes(tool));
}

function splitConnections(connections: readonly CharterConnection[]): {
  kept: CharterConnection[];
  narrowed: string[];
  dropped: string[];
} {
  const kept: CharterConnection[] = [];
  const narrowed: string[] = [];
  const dropped: string[] = [];
  for (const connection of connections) {
    if (!servesCalendar(connection)) {
      kept.push(structuredClone(connection));
      continue;
    }
    const serves = connection.serves.filter((tool) => !CALENDAR_TOOLS.includes(tool));
    if (serves.length === 0) {
      dropped.push(connection.system);
    } else {
      narrowed.push(connection.system);
      kept.push({ ...structuredClone(connection), serves });
    }
  }
  return { kept, narrowed, dropped };
}

/** The calendar connection for `provider`: serves read and write, names the provider as subprocessor. */
export function calendarConnection(provider: CalendarProvider): CharterConnection {
  return {
    system: CALENDAR_SYSTEM,
    label: CALENDAR_CONNECTION_LABEL,
    channel: 'api',
    serves: [...CALENDAR_SERVES],
    target: null,
    subprocessor: CALENDAR_SUBPROCESSOR[provider],
  };
}

function assertNoCalendar(active: BusinessCharter): void {
  if (active.connections.some((c) => c.system === CALENDAR_SYSTEM)) {
    throw new CalendarAlreadyDeclaredError(active.charterVersion);
  }
}

/** The diff `buildCalendarAmendment` would apply — for rendering, never for signing. */
export function describeCalendarAmendment(active: BusinessCharter, provider: CalendarProvider): CalendarAmendmentDiff {
  assertNoCalendar(active);
  const { narrowed, dropped } = splitConnections(active.connections);
  return {
    dropped,
    narrowed,
    subprocessorAdded: !active.data.subprocessorsAllowed.includes(CALENDAR_SUBPROCESSOR[provider]),
  };
}

/** The unsigned amendment. Throws `CalendarAlreadyDeclaredError` when a calendar is already declared. */
export function buildCalendarAmendment(active: BusinessCharter, now: Date, provider: CalendarProvider): UnsignedCharter {
  assertNoCalendar(active);
  const { signature: _signature, ...rest } = structuredClone(active);
  const { kept } = splitConnections(active.connections);
  const subprocessor = CALENDAR_SUBPROCESSOR[provider];
  return {
    ...rest,
    // `charter_version` is globally unique (migration 001): a ulid keeps two
    // amendments built from the same base distinct.
    charterVersion: `${active.charterVersion}.cal-${ulid()}`,
    effectiveFrom: now.toISOString(),
    supersedes: active.charterVersion,
    connections: [...kept, calendarConnection(provider)],
    data: {
      ...rest.data,
      subprocessorsAllowed: rest.data.subprocessorsAllowed.includes(subprocessor)
        ? rest.data.subprocessorsAllowed
        : [...rest.data.subprocessorsAllowed, subprocessor],
    },
  };
}

/**
 * The provider the SIGNED charter names for its calendar connection, or `null`
 * when the subprocessor is none this code knows. Positive match.
 */
export function signedCalendarProvider(connection: CharterConnection): CalendarProvider | null {
  for (const provider of ['google', 'microsoft'] as const) {
    if (connection.subprocessor === CALENDAR_SUBPROCESSOR[provider]) return provider;
  }
  return null;
}

/** Whether the OAuth ceremony may run for `provider` on this calendar connection: only the signed provider. */
export function calendarProviderMatchesCharter(connection: CharterConnection, provider: CalendarProvider): boolean {
  return signedCalendarProvider(connection) === provider;
}

/**
 * The way back. Removes the calendar connection and restores the connections
 * the amendment replaced (those in `previous` that served a calendar tool): a
 * narrowed one gets its original `serves` back, a dropped one returns. Every
 * other field -- including connections the owner signed after the amendment --
 * is the ACTIVE charter's. The calendar's subprocessor is removed from
 * `subprocessorsAllowed` only when `previous` did not allow it and no remaining
 * connection names it. A new version superseding the active one.
 */
export function buildCalendarRevert(active: BusinessCharter, now: Date, previous: BusinessCharter): UnsignedCharter {
  const calendar = active.connections.find((c) => c.system === CALENDAR_SYSTEM);
  if (calendar === undefined) throw new NoCalendarToRevertError(active.charterVersion);

  const replaced = previous.connections.filter(servesCalendar);
  const replacedBySystem = new Map(replaced.map((c) => [c.system, c] as const));
  const connections: CharterConnection[] = [];
  const seen = new Set<string>();
  for (const connection of active.connections) {
    if (connection.system === CALENDAR_SYSTEM) continue;
    const original = replacedBySystem.get(connection.system);
    connections.push(structuredClone(original ?? connection));
    seen.add(connection.system);
  }
  for (const original of replaced) {
    if (!seen.has(original.system)) connections.push(structuredClone(original));
  }

  const { signature: _signature, ...rest } = structuredClone(active);
  const subprocessor = calendar.subprocessor;
  const stillNamed = subprocessor !== null && connections.some((c) => c.subprocessor === subprocessor);
  const removeSubprocessor =
    subprocessor !== null && !previous.data.subprocessorsAllowed.includes(subprocessor) && !stillNamed;
  return {
    ...rest,
    charterVersion: `${active.charterVersion}.cal-revert-${ulid()}`,
    effectiveFrom: now.toISOString(),
    supersedes: active.charterVersion,
    connections,
    data: {
      ...rest.data,
      subprocessorsAllowed: removeSubprocessor
        ? rest.data.subprocessorsAllowed.filter((s) => s !== subprocessor)
        : [...rest.data.subprocessorsAllowed],
    },
  };
}
