/**
 * The contacts a name can be resolved against.
 *
 * A separate read from `recallMemories` on purpose, and the difference is the
 * ceiling: recall is capped at `MAX_RECALL` because it feeds a prompt with a
 * token budget, while this feeds a matcher. Reusing recall here would mean a
 * business quietly stopped recognising its contacts past the cap — the sort of
 * limit that produces "she used to know him" with nothing in any log.
 *
 * Only live entity rows carrying a name take part. A record with no name
 * cannot be matched by name, and including it would let an ambiguity count
 * contain a candidate the owner could never be shown (spec §4).
 */
import type { Queryable } from '../db/pool.js';
import { getPool } from '../db/pool.js';
import { config } from '../config.js';
import { TrustLevel } from '../domain/trust.js';

export interface Contact {
  /**
   * Every key this person's memories are stored under: the entity id, and the
   * address on the record when there is one. Spec §8 — the curator writes
   * under the address it wrote to, while older rows sit under the entity id,
   * so one person is split across both and recall by either returns half.
   */
  subjectKeys: string[];
  name: string;
  company: string | null;
  email: string | null;
  /**
   * The trust level of the memory row this contact was read from — whose word
   * the name and address are. A confirmation question shows it beside an
   * address that came from memory (boss command, spec §10.6), so the owner
   * can tell "you told me this" from "a document said this".
   */
  provenance: TrustLevel;
}

interface ContactRow {
  subject_key: string;
  body: Record<string, unknown>;
  provenance: string;
}

function readString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export async function listContacts(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<Contact[]> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<ContactRow>(
    `SELECT subject_key, body, provenance FROM memories
      WHERE business_id = $1 AND kind = 'entity' AND retired_at IS NULL
      ORDER BY created_at DESC`,
    [businessId],
  );

  const contacts: Contact[] = [];
  for (const row of rows) {
    const name = readString(row.body, 'name');
    if (name === null) continue;
    // A value that does not parse as a trust level is read as the least
    // trusted one: an unreadable value is never the permissive one.
    const provenance = TrustLevel.safeParse(row.provenance);

    const email = readString(row.body, 'email');
    const keys = [row.subject_key];
    if (email !== null && email.toLowerCase() !== row.subject_key.toLowerCase()) {
      keys.push(email.toLowerCase());
    }

    contacts.push({
      subjectKeys: keys,
      name,
      company: readString(row.body, 'company'),
      email: email === null ? null : email.toLowerCase(),
      provenance: provenance.success ? provenance.data : 'open_web',
    });
  }

  return contacts;
}
