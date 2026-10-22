/**
 * The one charter amendment the dashboard can build: adding the business's
 * own mailbox (Gmail / Microsoft 365) as the connection that sends mail.
 *
 * There is no general amendment flow. This module builds exactly one change
 * and nothing else, so what the owner is shown on the sign page and what is
 * hashed are the same small, fixed diff:
 *
 *   1. a `mailbox` connection is added, serving `mail.send` only;
 *   2. `mail.send` is removed from every other connection, and a connection
 *      left serving nothing is dropped (`office-mail`, the static SMTP one);
 *   3. the provider the owner chose is named as the connection's
 *      subprocessor and added to `data.subprocessorsAllowed` if absent —
 *      the schema refuses a subprocessor the charter does not allow, and the
 *      owner's mail passing through Google or Microsoft is precisely the kind
 *      of fact the charter exists to put in front of them;
 *   4. the amendment's own identity: a new `charterVersion`, `effectiveFrom`
 *      set to now, `supersedes` set to the active version.
 *
 * Every other field is copied verbatim (`amend-mailbox.test.ts` compares
 * them byte for byte).
 *
 * **Why the mailbox serves `mail.send` only, and not `mail.read` /
 * `mail.label`.** The charter schema refuses a `serves` entry no agent can
 * call (`BusinessCharter`'s "unknown tool" check): reading and labelling are
 * done by the deterministic poller, not by a tool a plan can name. They are
 * authorised by the owner's signature on this connection itself, which is
 * why the sign page (`dashboard/mailbox-connect.ts`) spells out in Hebrew
 * what signing lets the assistant do with the mailbox.
 */
import { ulid } from 'ulid';
import type { BusinessCharter, UnsignedCharter } from '../domain/charter.js';
import type { CharterConnection } from '../domain/connection.js';
import { MAILBOX_SYSTEM } from '../mail/mailbox.js';
import type { MailProvider } from '../mail/mailbox.js';

/** The subprocessor identifier the signed charter names for each provider. */
export const MAILBOX_SUBPROCESSOR: Readonly<Record<MailProvider, string>> = {
  google: 'google-workspace',
  microsoft: 'microsoft-365',
};

/** The owner-facing name of the connection, as it appears in the signed charter. */
export const MAILBOX_CONNECTION_LABEL = 'תיבת המייל של העסק';

/** The one tool the mailbox connection takes over from every other connection. */
const SEND_TOOL = 'mail.send';

export class MailboxAlreadyDeclaredError extends Error {
  constructor(charterVersion: string) {
    super(`charter ${charterVersion} already declares a "${MAILBOX_SYSTEM}" connection; refusing to add a second`);
    this.name = 'MailboxAlreadyDeclaredError';
  }
}

/**
 * What the amendment does to the existing connections — the diff the sign
 * page renders. Derived by the SAME function that builds the amendment
 * (`splitConnections`), so the page cannot describe a different change than
 * the one signed.
 */
export interface MailboxAmendmentDiff {
  /** Connections that stop serving `mail.send` but remain (they serve other tools). */
  readonly narrowed: readonly CharterConnection[];
  /** Connections removed entirely because `mail.send` was all they served. */
  readonly dropped: readonly CharterConnection[];
  /** Whether the provider's subprocessor is newly added to `subprocessorsAllowed`. */
  readonly subprocessorAdded: boolean;
}

function splitConnections(connections: readonly CharterConnection[]): {
  kept: CharterConnection[];
  narrowed: CharterConnection[];
  dropped: CharterConnection[];
} {
  const kept: CharterConnection[] = [];
  const narrowed: CharterConnection[] = [];
  const dropped: CharterConnection[] = [];
  for (const connection of connections) {
    if (!connection.serves.includes(SEND_TOOL)) {
      kept.push(structuredClone(connection));
      continue;
    }
    const serves = connection.serves.filter((tool) => tool !== SEND_TOOL);
    if (serves.length === 0) {
      dropped.push(connection);
    } else {
      narrowed.push(connection);
      kept.push({ ...structuredClone(connection), serves });
    }
  }
  return { kept, narrowed, dropped };
}

function assertNoMailbox(active: BusinessCharter): void {
  if (active.connections.some((c) => c.system === MAILBOX_SYSTEM)) {
    throw new MailboxAlreadyDeclaredError(active.charterVersion);
  }
}

/** The diff `buildMailboxAmendment` would apply — for rendering, never for signing. */
export function describeMailboxAmendment(active: BusinessCharter, provider: MailProvider): MailboxAmendmentDiff {
  assertNoMailbox(active);
  const { narrowed, dropped } = splitConnections(active.connections);
  return {
    narrowed,
    dropped,
    subprocessorAdded: !active.data.subprocessorsAllowed.includes(MAILBOX_SUBPROCESSOR[provider]),
  };
}

/**
 * The unsigned amendment. Throws `MailboxAlreadyDeclaredError` when the
 * active charter already declares a mailbox: a second one would collide on
 * `system`, and replacing the first is a different change than the one the
 * sign page describes.
 */
export function buildMailboxAmendment(
  active: BusinessCharter,
  now: Date,
  provider: MailProvider,
): UnsignedCharter {
  assertNoMailbox(active);

  const { signature: _signature, ...rest } = structuredClone(active);
  const { kept } = splitConnections(active.connections);
  const subprocessor = MAILBOX_SUBPROCESSOR[provider];

  const mailbox: CharterConnection = {
    system: MAILBOX_SYSTEM,
    label: MAILBOX_CONNECTION_LABEL,
    channel: 'api',
    serves: [SEND_TOOL],
    target: null,
    subprocessor,
  };

  return {
    ...rest,
    // `charter_version` is a global primary key across every business
    // (migration 001), so the version must be unique, not merely different
    // from the active one: a ulid suffix makes two amendments built from the
    // same base distinct.
    charterVersion: `${active.charterVersion}.mbx-${ulid()}`,
    effectiveFrom: now.toISOString(),
    supersedes: active.charterVersion,
    connections: [...kept, mailbox],
    data: {
      ...rest.data,
      subprocessorsAllowed: rest.data.subprocessorsAllowed.includes(subprocessor)
        ? rest.data.subprocessorsAllowed
        : [...rest.data.subprocessorsAllowed, subprocessor],
    },
  };
}

/**
 * The provider the SIGNED charter names for its mailbox, or `null` when the
 * mailbox connection names no subprocessor this code knows. Positive match
 * against `MAILBOX_SUBPROCESSOR`, never "anything that is not Google".
 */
export function signedMailboxProvider(connection: CharterConnection): MailProvider | null {
  for (const provider of ['google', 'microsoft'] as const) {
    if (connection.subprocessor === MAILBOX_SUBPROCESSOR[provider]) return provider;
  }
  return null;
}

/**
 * Whether the OAuth ceremony may run for `provider` on this mailbox
 * connection: only for the provider the owner signed for. Mail passing
 * through a provider the signed charter does not name is the change the
 * subprocessor list exists to put in front of the owner.
 */
export function mailboxProviderMatchesCharter(connection: CharterConnection, provider: MailProvider): boolean {
  return signedMailboxProvider(connection) === provider;
}

export class NoMailboxToRevertError extends Error {
  constructor(charterVersion: string) {
    super(`charter ${charterVersion} declares no "${MAILBOX_SYSTEM}" connection; nothing to revert`);
    this.name = 'NoMailboxToRevertError';
  }
}

/**
 * The way back: an amendment that undoes the mailbox amendment's two effects
 * on the charter -- `connections` and `data.subprocessorsAllowed` are
 * restored from `beforeMailbox`, the version the mailbox amendment
 * superseded. Every other field is the ACTIVE charter's, so a later change
 * the owner signed is not undone with it. A new version, effective now,
 * superseding the active one -- never a re-activation of the old row, which
 * would leave the trail saying the owner never signed the way back.
 *
 * Throws `NoMailboxToRevertError` when the active charter has no mailbox, and
 * refuses a `beforeMailbox` that itself declares one (it is then not the
 * version before the mailbox was added).
 */
export function buildMailboxRevert(
  active: BusinessCharter,
  beforeMailbox: BusinessCharter,
  now: Date,
): UnsignedCharter {
  if (!active.connections.some((c) => c.system === MAILBOX_SYSTEM)) {
    throw new NoMailboxToRevertError(active.charterVersion);
  }
  if (beforeMailbox.connections.some((c) => c.system === MAILBOX_SYSTEM)) {
    throw new Error(
      `charter ${beforeMailbox.charterVersion} already declares a mailbox; it is not the version before the mailbox amendment`,
    );
  }
  const { signature: _signature, ...rest } = structuredClone(active);
  return {
    ...rest,
    charterVersion: `${active.charterVersion}.mbx-revert-${ulid()}`,
    effectiveFrom: now.toISOString(),
    supersedes: active.charterVersion,
    connections: structuredClone(beforeMailbox.connections),
    data: {
      ...rest.data,
      subprocessorsAllowed: [...beforeMailbox.data.subprocessorsAllowed],
    },
  };
}
