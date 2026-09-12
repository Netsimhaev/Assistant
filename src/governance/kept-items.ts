/**
 * What the owner said to keep.
 *
 * Erasure removes everything an anchor reaches; this is the one list that
 * survives it. A kept item is never skipped silently — `buildErasurePlan`
 * carries it into the preview as an exclusion with the date it was kept, and
 * the screen offers to revoke it in one click (spec §6). A deletion that
 * quietly passed over things would be the same silent half-truth this
 * codebase keeps stamping out elsewhere.
 */
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';

/** Closed here and closed again by a CHECK in migration 025. */
export type KeptItemKind = 'document' | 'memory' | 'job';

export interface KeptItem {
  kind: KeptItemKind;
  itemId: string;
  keptAt: Date;
  note: string | null;
}

interface KeptRow {
  item_kind: string;
  item_id: string;
  kept_at: Date;
  note: string | null;
}

function toKeptItem(row: KeptRow): KeptItem {
  return {
    kind: row.item_kind as KeptItemKind,
    itemId: row.item_id,
    keptAt: row.kept_at,
    note: row.note,
  };
}

export async function keepItem(
  input: { kind: KeptItemKind; itemId: string; note?: string },
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const db = options.db ?? getPool();
  await db.query(
    `INSERT INTO kept_items (business_id, item_kind, item_id, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, item_kind, item_id)
     DO UPDATE SET note = EXCLUDED.note, kept_at = now()`,
    [options.businessId ?? config.businessId, input.kind, input.itemId, input.note ?? null],
  );
}

/** Returns how many rows it touched, so nothing can report success over zero. */
export async function revokeKeep(
  kind: KeptItemKind,
  itemId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<number> {
  const db = options.db ?? getPool();
  const result = await db.query(
    'DELETE FROM kept_items WHERE business_id = $1 AND item_kind = $2 AND item_id = $3',
    [options.businessId ?? config.businessId, kind, itemId],
  );
  return result.rowCount ?? 0;
}

export async function listKept(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<KeptItem[]> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<KeptRow>(
    `SELECT item_kind, item_id, kept_at, note FROM kept_items
      WHERE business_id = $1 ORDER BY kept_at DESC`,
    [options.businessId ?? config.businessId],
  );
  return rows.map(toKeptItem);
}

/** The ids of one kind, as a set the resolver can test membership against. */
export async function keptIds(
  kind: KeptItemKind,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<Set<string>> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ item_id: string }>(
    'SELECT item_id FROM kept_items WHERE business_id = $1 AND item_kind = $2',
    [options.businessId ?? config.businessId, kind],
  );
  return new Set(rows.map((row) => row.item_id));
}
