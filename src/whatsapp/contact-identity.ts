/**
 * Who wrote a WhatsApp message — deterministic, never a model call.
 *
 * A "contact" is only a person the OWNER vouched for: a row of
 * `listManagedContacts` (setup package / settings screen). Entities the
 * assistant learned from documents or mail never count — a stranger's text
 * must not be able to plant a number and become a contact. A colleague's
 * number wins over a contact row on the same number: colleagues are recorded
 * and never answered.
 */
import type { BusinessDb } from '../db/pool.js';
import type { BusinessCharter } from '../domain/charter.js';
import { authorityNumberKey, isPrincipalSender } from '../governance/principal-number.js';
import { listColleagues } from '../business/colleagues.js';
import { listManagedContacts, type ManagedContact } from '../business/settings-contacts.js';

export type ResolvedSender =
  | { kind: 'principal' }
  | { kind: 'colleague'; key: string }
  | { kind: 'contact'; key: string; contact: ManagedContact }
  | { kind: 'unknown'; key: string | null };

export async function resolveSender(db: BusinessDb, charter: BusinessCharter, senderNumber: string): Promise<ResolvedSender> {
  if (isPrincipalSender(charter, senderNumber)) return { kind: 'principal' };
  const key = authorityNumberKey(senderNumber);
  if (key === null) return { kind: 'unknown', key: null };
  const colleagues = await listColleagues(db);
  if (colleagues.some((c) => authorityNumberKey(c.phone) === key)) return { kind: 'colleague', key };
  const contacts = await listManagedContacts(db);
  const contact = contacts.find((c) => authorityNumberKey(c.phone) === key);
  if (contact !== undefined) return { kind: 'contact', key, contact };
  return { kind: 'unknown', key };
}
