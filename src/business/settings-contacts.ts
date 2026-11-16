/**
 * The contacts the owner manages on "הגדרות ← אנשים" (admin-panel spec).
 *
 * Only entity memories the setup wrote (`sourceRef 'setup_package'`, at the
 * first signature) or this screen wrote (`'settings_people'`) are listed,
 * edited or removed here. Entities the assistant learned from mail or
 * documents are not this screen's to show or change: the read is a positive
 * filter on those two source refs, and every edit/remove first re-checks that
 * the live row it targets carries one of them.
 *
 * The listing is its own query, not `listContacts`: that read feeds the name
 * matcher, does not return `source_ref`, and must keep returning every named
 * entity. Filtering it here would need a field it does not carry.
 *
 * Every write runs under a fresh job whose provenance is the literal `boss` —
 * `writeMemory` reads the provenance from the job, never from its input — in
 * one transaction with the job's transitions to `closed`. The key is the
 * canonical `+<digits>` phone, the same derivation `applySetupPeople` uses,
 * and the body is `{name, role, phone}`. Writing a key supersedes the live
 * row on it (soft retire, `writeMemory`) — but only a LEARNED entity (one
 * this screen does not manage) may be superseded that way: a write onto a
 * phone that a DIFFERENT managed contact (`setup_package`/`settings_people`)
 * holds is refused with `ContactPhoneTakenError`, before any job or write
 * (final review I3 — it used to retire that contact silently). Re-saving a
 * contact on its own key is an edit, not a conflict. A removal goes through
 * `retireMemories`, the function the `memory.retire` tool handler calls, so
 * the row stays with `retired_at` set.
 */
import { transaction, type BusinessDb } from '../db/pool.js';
import { activeCharterVersion } from '../charter/store.js';
import { retireMemories, writeMemory } from '../memory/store.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { SETUP_PACKAGE_SOURCE_REF } from './confirm-people.js';
import type { PersonEntry } from './setup-package.js';

export const SETTINGS_PEOPLE_SOURCE_REF = 'settings_people';

/** Shown when the phone typed belongs to another contact on this screen. */
export const CONTACT_PHONE_TAKEN = 'כבר יש איש קשר עם המספר הזה.';

/** A write onto a phone another managed contact holds. Carries the Hebrew sentence. */
export class ContactPhoneTakenError extends Error {
  constructor() {
    super(CONTACT_PHONE_TAKEN);
    this.name = 'ContactPhoneTakenError';
  }
}

/** The source refs this screen lists and may change. Closed. */
export const MANAGED_CONTACT_SOURCES = [SETUP_PACKAGE_SOURCE_REF, SETTINGS_PEOPLE_SOURCE_REF] as const;

export interface ManagedContact {
  subjectKey: string;
  name: string;
  role: string;
  phone: string;
}

interface ContactRow {
  subject_key: string;
  body: Record<string, unknown>;
}

function readString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

export async function listManagedContacts(db: BusinessDb): Promise<ManagedContact[]> {
  const { rows } = await db.query<ContactRow>(
    `SELECT subject_key, body FROM memories
      WHERE business_id = $1 AND kind = 'entity' AND retired_at IS NULL
        AND source_ref = ANY($2::text[])
      ORDER BY created_at, memory_id`,
    [db.businessId, [...MANAGED_CONTACT_SOURCES]],
  );
  return rows.map((row) => ({
    subjectKey: row.subject_key,
    name: readString(row.body, 'name'),
    role: readString(row.body, 'role'),
    phone: readString(row.body, 'phone'),
  }));
}

async function isManaged(db: BusinessDb, subjectKey: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM memories
      WHERE business_id = $1 AND kind = 'entity' AND subject_key = $2 AND retired_at IS NULL
        AND source_ref = ANY($3::text[])
      FOR UPDATE`,
    [db.businessId, subjectKey, [...MANAGED_CONTACT_SOURCES]],
  );
  return rows.length > 0;
}

/** Run `fn` under a closed `boss` job, in one transaction. */
async function asOwner<T>(db: BusinessDb, title: string, fn: (tx: BusinessDb, jobId: string) => Promise<T>): Promise<T> {
  return transaction(db, async (tx) => {
    const charterVersion = await activeCharterVersion(tx);
    if (charterVersion === null) throw new Error('settings contacts: no active charter');
    // The owner's own act: the provenance is a literal, never a parameter.
    const job = await createJob(tx, { charterVersion, provenance: 'boss', title });
    const result = await fn(tx, job.jobId);
    const reason = 'בעל העסק עדכן איש קשר בהגדרות';
    for (const to of ['understand', 'plan', 'closed'] as const) {
      await transition(tx, job.jobId, { to, actor: 'human', reason });
    }
    return result;
  });
}

function writeContact(tx: BusinessDb, jobId: string, entry: PersonEntry) {
  return writeMemory(tx, {
    jobId,
    kind: 'entity',
    subjectKey: entry.phone,
    body: { name: entry.name, role: entry.role, phone: entry.phone },
    sourceRef: SETTINGS_PEOPLE_SOURCE_REF,
  });
}

/**
 * `entry` must already be parsed with `PersonEntry` (canonical phone).
 * Throws `ContactPhoneTakenError` — no job, no write — when a managed contact
 * already holds that phone.
 */
export async function addManagedContact(db: BusinessDb, entry: PersonEntry): Promise<void> {
  await transaction(db, async (tx) => {
    if (await isManaged(tx, entry.phone)) throw new ContactPhoneTakenError();
    await asOwner(tx, 'הוספת איש קשר בהגדרות', (owner, jobId) => writeContact(owner, jobId, entry));
  });
}

/**
 * Replace the managed contact at `subjectKey` with `entry`. A changed phone
 * retires the old key and writes the new one. `false` — and no job, no write —
 * when no managed live contact has that key; `ContactPhoneTakenError` when the
 * new phone belongs to another managed contact.
 */
export async function updateManagedContact(db: BusinessDb, subjectKey: string, entry: PersonEntry): Promise<boolean> {
  return transaction(db, async (tx) => {
    if (!(await isManaged(tx, subjectKey))) return false;
    if (entry.phone !== subjectKey && (await isManaged(tx, entry.phone))) throw new ContactPhoneTakenError();
    await asOwner(tx, 'עדכון איש קשר בהגדרות', async (owner, jobId) => {
      if (entry.phone !== subjectKey) {
        await retireMemories(owner, { kind: 'entity', subjectKey, reason: 'phone changed by owner' });
      }
      await writeContact(owner, jobId, entry);
    });
    return true;
  });
}

/** Soft-retire the managed contact. `false` — and no job — when no managed live contact has that key. */
export async function removeManagedContact(db: BusinessDb, subjectKey: string): Promise<boolean> {
  return transaction(db, async (tx) => {
    if (!(await isManaged(tx, subjectKey))) return false;
    await asOwner(tx, 'הסרת איש קשר בהגדרות', (owner) =>
      retireMemories(owner, { kind: 'entity', subjectKey, reason: 'removed by owner' }),
    );
    return true;
  });
}
