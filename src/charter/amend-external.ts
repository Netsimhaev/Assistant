/**
 * The charter amendments that add, replace and remove one external system
 * (Stage D). Same shape as `amend-calendar.ts`: one fixed change, so what the
 * owner reads on the sign page and what is hashed are the same small diff.
 *
 * `buildExternalAmendment(active, def, now)`:
 *   1. `externalSystems` gains `def` — or, when a system with that id is
 *      already signed, `def` REPLACES it in place (a changed definition is a
 *      new signature, spec ruling 6; nothing is merged);
 *   2. the paired `ext:<id>` connection is added, or replaces the old one in
 *      place: `{ system: 'ext:<id>', label, channel: 'api',
 *      serves: ['ext.call', 'ext.read'], target: <id>, subprocessor }`;
 *   3. the subprocessor is added to `data.subprocessorsAllowed` if absent;
 *   4. a new `charterVersion`, `effectiveFrom` now, `supersedes` the active one.
 *
 * `buildExternalRemoval(active, id, now)` drops the system and its `ext:<id>`
 * connection, as a new version superseding the active one.
 *
 * Every other field is copied verbatim (`amend-external.test.ts`).
 *
 * **The subprocessor rule.** An external system's data goes to the company
 * that runs it, so its connection names a subprocessor, exactly as the
 * mailbox and calendar connections name Google / Microsoft. The name is
 * derived from the system id — `ext:<id>`, the same string as the connection
 * system — so it is stable across replacements (a new base URL does not mint
 * a new subprocessor) and can never collide with the mailbox / calendar
 * names, which carry no colon. Removal does NOT take it out of
 * `subprocessorsAllowed`, the same as the calendar revert leaves a name the
 * owner once allowed: an allowance with no connection naming it routes
 * nothing, and narrowing the list is a separate decision the owner can sign
 * in "ערוך את הכללים".
 */
import { ulid } from 'ulid';
import type { BusinessCharter, UnsignedCharter } from '../domain/charter.js';
import type { CharterConnection } from '../domain/connection.js';
import { externalConnectionSystem, type ExternalSystem } from '../domain/external-system.js';
import { canonicalHash } from '../util/canonical.js';

/** The tools an external system's connection serves — exactly these, in this order. */
const EXTERNAL_SERVES = ['ext.call', 'ext.read'];

/** The subprocessor an external system's connection names (see the module docblock). */
export function externalSubprocessor(id: string): string {
  return externalConnectionSystem(id);
}

export class NoExternalSystemToRemoveError extends Error {
  constructor(charterVersion: string, id: string) {
    super(`charter ${charterVersion} declares no external system "${id}"; nothing to remove`);
    this.name = 'NoExternalSystemToRemoveError';
  }
}

/** The connection a charter must carry for `def`. */
export function externalConnection(def: ExternalSystem): CharterConnection {
  return {
    system: externalConnectionSystem(def.id),
    label: def.label,
    channel: 'api',
    serves: [...EXTERNAL_SERVES],
    target: def.id,
    subprocessor: externalSubprocessor(def.id),
  };
}

/** The host of a definition's base URL — the company the data goes to. */
export function externalHost(def: ExternalSystem): string {
  return new URL(def.baseUrl).host;
}

/** What a replacement changes, at the level of operation names and the host. */
export interface ExternalAmendmentDiff {
  /** `true` when a system with this id is already signed. */
  readonly replaces: boolean;
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
  /** Both hosts when the base URL's host changed; `null` otherwise. */
  readonly host: { readonly before: string; readonly after: string } | null;
  /** Anything else in the definition (label, auth, webhook, scan…) differs. */
  readonly otherChanged: boolean;
}

/** The diff `buildExternalAmendment` would apply — for rendering, never for signing. */
export function describeExternalAmendment(active: BusinessCharter, def: ExternalSystem): ExternalAmendmentDiff {
  const previous = active.externalSystems.find((s) => s.id === def.id);
  if (previous === undefined) {
    return { replaces: false, added: def.operations.map((o) => o.name), removed: [], changed: [], host: null, otherChanged: false };
  }
  const before = new Map(previous.operations.map((o) => [o.name, o] as const));
  const after = new Map(def.operations.map((o) => [o.name, o] as const));
  const added = def.operations.filter((o) => !before.has(o.name)).map((o) => o.name);
  const removed = previous.operations.filter((o) => !after.has(o.name)).map((o) => o.name);
  const changed = def.operations
    .filter((o) => {
      const old = before.get(o.name);
      return old !== undefined && canonicalHash(old) !== canonicalHash(o);
    })
    .map((o) => o.name);
  const hostBefore = externalHost(previous);
  const hostAfter = externalHost(def);
  const { operations: _a, ...restBefore } = previous;
  const { operations: _b, ...restAfter } = def;
  return {
    replaces: true,
    added,
    removed,
    changed,
    host: hostBefore === hostAfter ? null : { before: hostBefore, after: hostAfter },
    otherChanged: canonicalHash(restBefore) !== canonicalHash(restAfter),
  };
}

/** The unsigned amendment that adds `def`, or replaces the signed system with its id. */
export function buildExternalAmendment(active: BusinessCharter, def: ExternalSystem, now: Date): UnsignedCharter {
  const { signature: _signature, ...rest } = structuredClone(active);
  const name = externalConnectionSystem(def.id);
  const definition = structuredClone(def);
  const connection = externalConnection(def);

  const replacesSystem = rest.externalSystems.some((s) => s.id === def.id);
  const externalSystems = replacesSystem
    ? rest.externalSystems.map((s) => (s.id === def.id ? definition : s))
    : [...rest.externalSystems, definition];
  const replacesConnection = rest.connections.some((c) => c.system === name);
  const connections = replacesConnection
    ? rest.connections.map((c) => (c.system === name ? connection : c))
    : [...rest.connections, connection];
  const subprocessor = externalSubprocessor(def.id);

  return {
    ...rest,
    // `charter_version` is globally unique (migration 001): a ulid keeps two
    // amendments built from the same base distinct.
    charterVersion: `${active.charterVersion}.ext-${ulid()}`,
    effectiveFrom: now.toISOString(),
    supersedes: active.charterVersion,
    externalSystems,
    connections,
    data: {
      ...rest.data,
      subprocessorsAllowed: rest.data.subprocessorsAllowed.includes(subprocessor)
        ? rest.data.subprocessorsAllowed
        : [...rest.data.subprocessorsAllowed, subprocessor],
    },
  };
}

/**
 * The unsigned amendment that drops system `id` and its `ext:<id>` connection.
 * Throws `NoExternalSystemToRemoveError` when the active charter has no such
 * system. `subprocessorsAllowed` is left as it is (module docblock).
 */
export function buildExternalRemoval(active: BusinessCharter, id: string, now: Date): UnsignedCharter {
  if (!active.externalSystems.some((s) => s.id === id)) {
    throw new NoExternalSystemToRemoveError(active.charterVersion, id);
  }
  const { signature: _signature, ...rest } = structuredClone(active);
  const name = externalConnectionSystem(id);
  return {
    ...rest,
    charterVersion: `${active.charterVersion}.ext-remove-${ulid()}`,
    effectiveFrom: now.toISOString(),
    supersedes: active.charterVersion,
    externalSystems: rest.externalSystems.filter((s) => s.id !== id),
    connections: rest.connections.filter((c) => c.system !== name),
  };
}
