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
