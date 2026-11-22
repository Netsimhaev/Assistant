/**
 * The charter amendment that connects the WhatsApp channel to clients and
 * suppliers (phase 1: sending only after the owner approved each message, or on
 * the owner's direct instruction).
 *
 * Same shape as `amend-calendar.ts`: one fixed change —
 *   1. a `whatsapp-contacts` connection is added, serving `wa.send_message`;
 *   2. the provider's subprocessor (`green-api`) is named on the connection and
 *      added to `data.subprocessorsAllowed` if absent;
 *   3. a new `charterVersion`, `effectiveFrom` now, `supersedes` the active one.
 * Every other field is copied verbatim.
 *
 * The revert removes the connection and leaves `subprocessorsAllowed` as it is:
 * the owner's own WhatsApp channel may rely on the same provider, and leaving an
 * allowance in place never widens anything.
 */
import { ulid } from 'ulid';
import type { BusinessCharter, UnsignedCharter } from '../domain/charter.js';
import type { CharterConnection } from '../domain/connection.js';

export const WHATSAPP_CONTACTS_SYSTEM = 'whatsapp-contacts';
export const WHATSAPP_CONTACTS_SUBPROCESSOR = 'green-api';
export const WHATSAPP_CONTACTS_LABEL = 'וואטסאפ ללקוחות ולספקים';

export class WhatsAppContactsAlreadyDeclaredError extends Error {
  constructor(charterVersion: string) {
    super(`charter ${charterVersion} already declares a "${WHATSAPP_CONTACTS_SYSTEM}" connection; refusing to add a second`);
    this.name = 'WhatsAppContactsAlreadyDeclaredError';
  }
}

export class NoWhatsAppContactsToRevertError extends Error {
  constructor(charterVersion: string) {
    super(`charter ${charterVersion} declares no "${WHATSAPP_CONTACTS_SYSTEM}" connection; nothing to revert`);
    this.name = 'NoWhatsAppContactsToRevertError';
  }
}

export function whatsAppContactsConnection(): CharterConnection {
  return {
    system: WHATSAPP_CONTACTS_SYSTEM,
    label: WHATSAPP_CONTACTS_LABEL,
    channel: 'api',
    serves: ['wa.send_message'],
    target: WHATSAPP_CONTACTS_SYSTEM,
    subprocessor: WHATSAPP_CONTACTS_SUBPROCESSOR,
  };
}

export function declaresWhatsAppContacts(charter: BusinessCharter): boolean {
  return charter.connections.some((c) => c.system === WHATSAPP_CONTACTS_SYSTEM);
}

/** Whether signing would add the subprocessor to the allowed list — for the sign page. */
export function whatsAppContactsSubprocessorAdded(active: BusinessCharter): boolean {
  return !active.data.subprocessorsAllowed.includes(WHATSAPP_CONTACTS_SUBPROCESSOR);
}

export function buildWhatsAppContactsAmendment(active: BusinessCharter, now: Date): UnsignedCharter {
  if (declaresWhatsAppContacts(active)) throw new WhatsAppContactsAlreadyDeclaredError(active.charterVersion);
  const { signature: _signature, ...rest } = structuredClone(active);
  return {
    ...rest,
    charterVersion: `${active.charterVersion}.wac-${ulid()}`,
    effectiveFrom: now.toISOString(),
    supersedes: active.charterVersion,
    connections: [...rest.connections, whatsAppContactsConnection()],
    data: {
      ...rest.data,
      subprocessorsAllowed: rest.data.subprocessorsAllowed.includes(WHATSAPP_CONTACTS_SUBPROCESSOR)
        ? rest.data.subprocessorsAllowed
        : [...rest.data.subprocessorsAllowed, WHATSAPP_CONTACTS_SUBPROCESSOR],
    },
  };
}

export function buildWhatsAppContactsRevert(active: BusinessCharter, now: Date): UnsignedCharter {
  if (!declaresWhatsAppContacts(active)) throw new NoWhatsAppContactsToRevertError(active.charterVersion);
  const { signature: _signature, ...rest } = structuredClone(active);
  return {
    ...rest,
    charterVersion: `${active.charterVersion}.wac-revert-${ulid()}`,
    effectiveFrom: now.toISOString(),
    supersedes: active.charterVersion,
    connections: rest.connections.filter((c) => c.system !== WHATSAPP_CONTACTS_SYSTEM),
  };
}
