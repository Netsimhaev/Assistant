/**
 * The read of the contacts the owner manages (setup package / "הגדרות ←
 * אנשים"): live entity memories whose `source_ref` is one of the reserved
 * owner-only refs AND whose provenance is `boss`.
 *
 * It lives here, under `src/memory/`, and not in `business/settings-contacts.ts`
 * (which re-exports it) because the policy gate needs it at send time
 * (`policy/contact-reply.ts`) and `src/policy/` must never reach `src/business/`
 * at any depth (`business/description-invariants.test.ts`). One definition of
 * "managed contact" for every reader — a second copy of this filter would be
 * a second place for the two to drift.
 */
import type { BusinessDb } from '../db/pool.js';
import { RESERVED_SOURCE_REFS } from './store.js';

/** The source refs a managed contact carries. Closed — the owner-only refs. */
export const MANAGED_CONTACT_SOURCES = RESERVED_SOURCE_REFS;

export interface ManagedContact {
  subjectKey: string;
  name: string;
  role: string;
  phone: string;
  kind: 'client' | 'supplier' | null;
  email: string | null;
  externalIds: Record<string, string>;
}

interface ContactRow {
  subject_key: string;
  body: Record<string, unknown>;
}

function readString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function readExternalIds(body: Record<string, unknown>): Record<string, string> {
  const value = body['externalIds'];
  const out: Record<string, string> = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string' && v !== '') out[k] = v;
  return out;
}

function readKind(body: Record<string, unknown>): 'client' | 'supplier' | null {
  const value = body['kind'];
  return value === 'client' || value === 'supplier' ? value : null;
}

export async function listManagedContacts(db: BusinessDb): Promise<ManagedContact[]> {
  const { rows } = await db.query<ContactRow>(
    `SELECT subject_key, body FROM memories
      WHERE business_id = $1 AND kind = 'entity' AND retired_at IS NULL
        AND source_ref = ANY($2::text[])
        -- Belt and braces beside the write-side guard (writeMemory strips the
        -- reserved refs): only the owner's own writes are boss jobs.
        AND provenance = 'boss'
      ORDER BY created_at, memory_id`,
    [db.businessId, [...MANAGED_CONTACT_SOURCES]],
  );
  return rows.map((row) => ({
    subjectKey: row.subject_key,
    name: readString(row.body, 'name'),
    role: readString(row.body, 'role'),
    phone: readString(row.body, 'phone'),
    kind: readKind(row.body),
    email: readString(row.body, 'email') || null,
    externalIds: readExternalIds(row.body),
  }));
}
