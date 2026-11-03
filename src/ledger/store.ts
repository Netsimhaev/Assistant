/**
 * Ledger store: CRUD and status moves for `ledger_items` / `ledger_events`.
 *
 * Every query filters by `business_id` — events included, because
 * `ledger_events.business_id` is not tied to the item by a foreign key.
 * Every status move is a conditional UPDATE; losing the race returns false.
 */
import pg from 'pg';
import { monotonicFactory } from 'ulid';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';
import {
  LedgerStage,
  type Importance,
  type LedgerEvent,
  type LedgerEventKind,
  type LedgerFamily,
  type LedgerItem,
  type LedgerStatus,
} from '../domain/ledger.js';

/** Monotonic so ids minted in one millisecond still sort in mint order. */
const ulid = monotonicFactory();

export class LedgerItemNotFoundError extends Error {
  constructor(itemId: string) {
    super(`Ledger item not found: ${itemId}`);
    this.name = 'LedgerItemNotFoundError';
  }
}

export interface NewLedgerItem {
  family: LedgerFamily;
  description: string;
  dueAt: Date | null;
  dueIsDateOnly: boolean;
  importance: Importance;
  importanceManual: boolean;
  counterpartyName: string | null;
  counterpartyEmail: string | null;
  counterpartyEmailVerified: boolean;
  counterpartyDomain: string | null;
  reference: string | null;
  amountMinor: number | null;
  stages: LedgerStage[];
  proposedStages: LedgerStage[] | null;
  originJobId: string;
}

export type LedgerPatch = Partial<
  Pick<
    LedgerItem,
    | 'description'
    | 'dueAt'
    | 'dueIsDateOnly'
    | 'importance'
    | 'importanceManual'
    | 'reference'
    | 'amountMinor'
    | 'stages'
    | 'proposedStages'
    | 'counterpartyEmailVerified'
  >
>;

interface StoreOpts {
  businessId: string;
  db?: Queryable;
}

interface ItemRow {
  item_id: string;
  business_id: string;
  family: LedgerFamily;
  description: string;
  due_at: Date | null;
  due_is_date_only: boolean;
  importance: Importance;
  importance_manual: boolean;
  counterparty_name: string | null;
  counterparty_email: string | null;
  counterparty_email_verified: boolean;
  counterparty_domain: string | null;
  reference: string | null;
  amount_minor: bigint | string | number | null;
  stages: unknown;
  proposed_stages: unknown;
  status: LedgerStatus;
  nudge_count: number;
  evidence_after: Date;
  origin_job_id: string;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

interface EventRow {
  event_id: string;
  item_id: string;
  kind: LedgerEventKind;
  job_id: string | null;
  mail_id: string | null;
  note: string | null;
  by_whom: string;
  at: Date;
}

function toAmount(value: ItemRow['amount_minor']): number | null {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`ledger amount_minor is not a safe integer: ${String(value)}`);
  return n;
}

function toLedgerItem(row: ItemRow): LedgerItem {
  return {
    itemId: row.item_id,
    businessId: row.business_id,
    family: row.family,
    description: row.description,
    dueAt: row.due_at,
    dueIsDateOnly: row.due_is_date_only,
    importance: row.importance,
    importanceManual: row.importance_manual,
    counterpartyName: row.counterparty_name,
    counterpartyEmail: row.counterparty_email,
    counterpartyEmailVerified: row.counterparty_email_verified,
    counterpartyDomain: row.counterparty_domain,
    reference: row.reference,
    amountMinor: toAmount(row.amount_minor),
    stages: LedgerStage.array().parse(row.stages),
    proposedStages: row.proposed_stages === null ? null : LedgerStage.array().parse(row.proposed_stages),
    status: row.status,
    nudgeCount: row.nudge_count,
    evidenceAfter: row.evidence_after,
    originJobId: row.origin_job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

function toLedgerEvent(row: EventRow): LedgerEvent {
  return {
    eventId: row.event_id,
    itemId: row.item_id,
    kind: row.kind,
    jobId: row.job_id,
    mailId: row.mail_id,
    note: row.note,
    byWhom: row.by_whom,
    at: row.at,
  };
}

/**
 * Run `fn` atomically. No `db` or a pool: open our own transaction. A client
 * (assumed already inside the caller's transaction): use it as is.
 */
export async function atomically<T>(db: Queryable | undefined, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  if (db === undefined || db instanceof pg.Pool) return withTransaction(fn);
  return fn(db);
}

async function insertEvent(
  tx: Queryable,
  businessId: string,
  itemId: string,
  event: { kind: LedgerEventKind; by: string; jobId?: string; mailId?: string; note?: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO ledger_events (event_id, business_id, item_id, kind, job_id, mail_id, note, by_whom, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())`,
    [`LE-${ulid()}`, businessId, itemId, event.kind, event.jobId ?? null, event.mailId ?? null, event.note ?? null, event.by],
  );
}

export async function createLedgerItem(
  item: NewLedgerItem,
  opts: { businessId: string; by: string; db?: Queryable },
): Promise<LedgerItem> {
  return atomically(opts.db, async (tx) => {
    const res = await tx.query<ItemRow>(
      `INSERT INTO ledger_items
         (item_id, business_id, family, description, due_at, due_is_date_only, importance, importance_manual,
          counterparty_name, counterparty_email, counterparty_email_verified, counterparty_domain,
          reference, amount_minor, stages, proposed_stages, origin_job_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17)
       RETURNING *`,
      [
        `LI-${ulid()}`,
        opts.businessId,
        item.family,
        item.description,
        item.dueAt,
        item.dueIsDateOnly,
        item.importance,
        item.importanceManual,
        item.counterpartyName,
        item.counterpartyEmail,
        item.counterpartyEmailVerified,
        item.counterpartyDomain,
        item.reference,
        item.amountMinor,
        JSON.stringify(item.stages),
        item.proposedStages === null ? null : JSON.stringify(item.proposedStages),
        item.originJobId,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error('ledger insert returned no row');
    await insertEvent(tx, opts.businessId, row.item_id, { kind: 'created', by: opts.by, jobId: item.originJobId });
    return toLedgerItem(row);
  });
}

export async function loadLedgerItem(itemId: string, opts: StoreOpts): Promise<LedgerItem | null> {
  const db = opts.db ?? getPool();
  const res = await db.query<ItemRow>(
    'SELECT * FROM ledger_items WHERE business_id = $1 AND item_id = $2',
    [opts.businessId, itemId],
  );
  const row = res.rows[0];
  return row ? toLedgerItem(row) : null;
}

export async function listLedgerItems(opts: StoreOpts & { statuses?: LedgerStatus[] }): Promise<LedgerItem[]> {
  const db = opts.db ?? getPool();
  const params: unknown[] = [opts.businessId];
  let where = 'business_id = $1';
  if (opts.statuses) {
    params.push(opts.statuses);
    where += ' AND status = ANY($2)';
  }
  const res = await db.query<ItemRow>(
    `SELECT * FROM ledger_items WHERE ${where}
     ORDER BY (importance = 'critical') DESC, due_at ASC NULLS LAST, created_at ASC, item_id ASC`,
    params,
  );
  return res.rows.map(toLedgerItem);
}

/** Column and value conversion per patchable field. */
const PATCH_COLUMNS: Record<keyof LedgerPatch, { column: string; cast?: string; encode?: (v: never) => unknown }> = {
  description: { column: 'description' },
  dueAt: { column: 'due_at' },
  dueIsDateOnly: { column: 'due_is_date_only' },
  importance: { column: 'importance' },
  importanceManual: { column: 'importance_manual' },
  reference: { column: 'reference' },
  amountMinor: { column: 'amount_minor' },
  stages: { column: 'stages', cast: '::jsonb', encode: (v: LedgerStage[]) => JSON.stringify(v) },
  proposedStages: {
    column: 'proposed_stages',
    cast: '::jsonb',
    encode: (v: LedgerStage[] | null) => (v === null ? null : JSON.stringify(v)),
  },
  counterpartyEmailVerified: { column: 'counterparty_email_verified' },
};

export async function updateLedgerItem(
  itemId: string,
  patch: LedgerPatch,
  event: { kind: LedgerEventKind; by: string; jobId?: string; note?: string },
  opts: StoreOpts,
): Promise<LedgerItem> {
  return atomically(opts.db, async (tx) => {
    const params: unknown[] = [opts.businessId, itemId];
    const sets: string[] = ['updated_at = now()'];
    for (const key of Object.keys(PATCH_COLUMNS) as (keyof LedgerPatch)[]) {
      if (!Object.hasOwn(patch, key)) continue;
      const spec = PATCH_COLUMNS[key];
      const raw = patch[key];
      params.push(spec.encode ? (spec.encode as (v: unknown) => unknown)(raw) : raw);
      sets.push(`${spec.column} = $${params.length}${spec.cast ?? ''}`);
    }
    const res = await tx.query<ItemRow>(
      `UPDATE ledger_items SET ${sets.join(', ')} WHERE business_id = $1 AND item_id = $2 RETURNING *`,
      params,
    );
    const row = res.rows[0];
    if (!row) throw new LedgerItemNotFoundError(itemId);
    await insertEvent(tx, opts.businessId, itemId, event);
    return toLedgerItem(row);
  });
}

const CLOSING: readonly LedgerStatus[] = ['closed_by_evidence', 'done', 'cancelled'];

export async function moveLedgerStatus(
  itemId: string,
  from: LedgerStatus[],
  to: LedgerStatus,
  event: { kind: LedgerEventKind; by: string; jobId?: string; mailId?: string; note?: string },
  opts: StoreOpts,
): Promise<boolean> {
  const closedAt = CLOSING.includes(to) ? 'now()' : 'NULL';
  const evidence = to === 'open' ? ', evidence_after = now()' : '';
  return atomically(opts.db, async (tx) => {
    const res = await tx.query(
      `UPDATE ledger_items
         SET status = $3, closed_at = ${closedAt}, updated_at = now()${evidence}
       WHERE business_id = $1 AND item_id = $2 AND status = ANY($4)`,
      [opts.businessId, itemId, to, from],
    );
    if ((res.rowCount ?? 0) === 0) return false;
    await insertEvent(tx, opts.businessId, itemId, event);
    return true;
  });
}

export async function listLedgerEvents(itemId: string, opts: StoreOpts): Promise<LedgerEvent[]> {
  const db = opts.db ?? getPool();
  const res = await db.query<EventRow>(
    'SELECT * FROM ledger_events WHERE business_id = $1 AND item_id = $2 ORDER BY at ASC, event_id ASC',
    [opts.businessId, itemId],
  );
  return res.rows.map(toLedgerEvent);
}
