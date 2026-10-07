import { ulid } from 'ulid';
import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { getPool } from '../db/pool.js';
import type { DigestKind, DigestWindow } from './digest-window.js';
import type { RenderedDigest } from './digest-render.js';

export type ChannelState = 'sent' | 'failed' | 'skipped_not_connected';

export interface StoredDigest {
  digestId: string;
  kind: DigestKind;
  windowStart: string;
  windowEnd: string;
  body: string;
  hadContent: boolean;
  createdAt: string;
  emailState: ChannelState | null;
  whatsappState: ChannelState | null;
}

interface DigestRow {
  digest_id: string;
  kind: string;
  window_start: string;
  window_end: string;
  body: string;
  had_content: boolean;
  created_at: string;
  email_state: string | null;
  whatsapp_state: string | null;
}

const COLUMNS = `digest_id, kind, window_start::text AS window_start, window_end::text AS window_end,
                 body, had_content, created_at::text AS created_at, email_state, whatsapp_state`;

function toStored(row: DigestRow): StoredDigest {
  return {
    digestId: row.digest_id,
    kind: row.kind as DigestKind,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    body: row.body,
    hadContent: row.had_content,
    createdAt: row.created_at,
    emailState: row.email_state as ChannelState | null,
    whatsappState: row.whatsapp_state as ChannelState | null,
  };
}

/**
 * Writes the rendered digest down **before** anything is delivered — spec §6.
 *
 * Deliver-then-store leaves a window in which the owner has been told
 * something no record exists of. Store-then-deliver leaves at worst a stored
 * digest whose delivery outcome is unknown, which the next pass can see and an
 * operator can read. That is the same direction `trip()` and the WhatsApp
 * report already chose, and for the same reason.
 */
export async function storeDigest(
  input: { window: DigestWindow; rendered: RenderedDigest },
  options: { businessId?: string; db?: Queryable } = {},
): Promise<StoredDigest> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const id = `DG-${ulid()}`;

  const { rows } = await db.query<DigestRow>(
    `INSERT INTO digests
       (digest_id, business_id, kind, window_start, window_end, body, had_content, screen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     RETURNING ${COLUMNS}`,
    [id, businessId, input.window.kind, input.window.start, input.window.end,
     input.rendered.body, input.rendered.hadContent],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('digest vanished mid-insert');
  return toStored(row);
}

/**
 * Throws when `digestId` under `businessId` matches no row.
 *
 * A silent miss would lose the delivery outcome of a digest the owner may
 * already have received, and nothing downstream would ever say so — the same
 * reasoning `settleMessage` (`whatsapp/store.ts`) and `markContentIngested`
 * (`documents/read.ts`) already apply to their own UPDATEs.
 */
export async function recordChannel(
  digestId: string,
  channel: 'email' | 'whatsapp',
  state: ChannelState,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const column = channel === 'email' ? 'email_state' : 'whatsapp_state';

  const { rowCount } = await db.query(
    `UPDATE digests SET ${column} = $3 WHERE digest_id = $1 AND business_id = $2`,
    [digestId, businessId, state],
  );
  if (rowCount !== 1) {
    throw new Error(`digest ${digestId} not found for business ${businessId}`);
  }
}

export async function lastWindowEnd(
  kind: DigestKind,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<Date | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<{ window_end: string }>(
    `SELECT window_end::text AS window_end FROM digests
      WHERE business_id = $1 AND kind = $2
      ORDER BY window_end DESC LIMIT 1`,
    [businessId, kind],
  );
  const row = rows[0];
  return row === undefined ? null : new Date(row.window_end);
}

export async function recentDigests(
  options: { businessId?: string; limit?: number; db?: Queryable } = {},
): Promise<StoredDigest[]> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const limit = options.limit ?? 30;

  const { rows } = await db.query<DigestRow>(
    `SELECT ${COLUMNS} FROM digests
      WHERE business_id = $1
      ORDER BY window_end DESC, digest_id DESC
      LIMIT $2`,
    [businessId, limit],
  );
  return rows.map(toStored);
}
