import { config } from '../config.js';
import { ConnectionBinding } from '../domain/connection.js';
import { getPool, type Queryable } from '../db/pool.js';

interface BindingRow {
  system: string;
  status: string;
  endpoint: string | null;
  credential_ref: string | null;
  last_ok_at: Date | null;
  last_error: string | null;
}

function toBinding(row: BindingRow): ConnectionBinding {
  return ConnectionBinding.parse({
    system: row.system,
    status: row.status,
    endpoint: row.endpoint,
    credentialRef: row.credential_ref,
    lastOkAt: row.last_ok_at?.toISOString() ?? null,
    lastError: row.last_error,
  });
}

export async function loadBindings(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ConnectionBinding[]> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<BindingRow>(
    `SELECT system, status, endpoint, credential_ref, last_ok_at, last_error
       FROM connection_bindings
      WHERE business_id = $1
      ORDER BY system`,
    [options.businessId ?? config.businessId],
  );
  return rows.map(toBinding);
}

export async function upsertBinding(
  binding: ConnectionBinding,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const db = options.db ?? getPool();
  await db.query(
    `INSERT INTO connection_bindings
       (business_id, system, status, endpoint, credential_ref, last_ok_at, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (business_id, system) DO UPDATE
       SET status = EXCLUDED.status,
           endpoint = EXCLUDED.endpoint,
           credential_ref = EXCLUDED.credential_ref,
           last_ok_at = EXCLUDED.last_ok_at,
           last_error = EXCLUDED.last_error,
           updated_at = now()`,
    [
      options.businessId ?? config.businessId,
      binding.system,
      binding.status,
      binding.endpoint,
      binding.credentialRef,
      binding.lastOkAt,
      binding.lastError,
    ],
  );
}
