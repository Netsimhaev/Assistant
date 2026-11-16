/**
 * The business's confirmed colleagues (admin-panel spec).
 *
 * A colleague is someone the assistant knows works with the owner — never
 * someone who gives it instructions. A WhatsApp message from a colleague's
 * number is recorded and not answered, exactly like a stranger's; nothing in
 * this module grants authority.
 *
 * Each row is validated with the same `PersonEntry` the setup package uses,
 * so a phone here is always canonical `+<digits>`. Contact erasure deletes a
 * row whose name or phone matches (`erasure-plan.ts`).
 */
import { ulid } from 'ulid';
import type { BusinessDb } from '../db/pool.js';
import { PersonEntry } from './setup-package.js';

export interface Colleague {
  colleagueId: string;
  name: string;
  role: string;
  phone: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ColleagueRow {
  colleague_id: string;
  name: string;
  role: string;
  phone: string;
  created_at: Date;
  updated_at: Date;
}

function toColleague(row: ColleagueRow): Colleague {
  return {
    colleagueId: row.colleague_id,
    name: row.name,
    role: row.role,
    phone: row.phone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listColleagues(db: BusinessDb): Promise<Colleague[]> {
  const { rows } = await db.query<ColleagueRow>(
    `SELECT colleague_id, name, role, phone, created_at, updated_at
       FROM business_colleagues
      WHERE business_id = $1
      ORDER BY created_at, colleague_id`,
    [db.businessId],
  );
  return rows.map(toColleague);
}

export async function addColleague(db: BusinessDb, entry: PersonEntry): Promise<string> {
  const parsed = PersonEntry.parse(entry);
  const colleagueId = ulid();
  await db.query(
    `INSERT INTO business_colleagues (business_id, colleague_id, name, role, phone)
     VALUES ($1, $2, $3, $4, $5)`,
    [db.businessId, colleagueId, parsed.name, parsed.role, parsed.phone],
  );
  return colleagueId;
}

/** `false` when no colleague of this business has that id. */
export async function updateColleague(db: BusinessDb, colleagueId: string, entry: PersonEntry): Promise<boolean> {
  const parsed = PersonEntry.parse(entry);
  const { rowCount } = await db.query(
    `UPDATE business_colleagues
        SET name = $3, role = $4, phone = $5, updated_at = now()
      WHERE business_id = $1 AND colleague_id = $2`,
    [db.businessId, colleagueId, parsed.name, parsed.role, parsed.phone],
  );
  return (rowCount ?? 0) > 0;
}

/** `false` when no colleague of this business has that id. */
export async function removeColleague(db: BusinessDb, colleagueId: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM business_colleagues WHERE business_id = $1 AND colleague_id = $2', [
    db.businessId,
    colleagueId,
  ]);
  return (rowCount ?? 0) > 0;
}
