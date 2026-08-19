import { config } from '../config.js';
import { ConnectionBinding } from '../domain/connection.js';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';

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

/**
 * Store the operational state of one system's connection.
 *
 * Validates before writing: a bad row (e.g. `system: ''`) must fail here, not
 * surface as a broken read later for every other binding on the business.
 *
 * This is a WHOLE-ROW replace, never a patch. `ConnectionBinding` has no
 * optional fields, so a caller that wants to change only `status` still has
 * to supply `endpoint`, `credentialRef`, etc. explicitly. A future
 * `setStatus(system, status)` convenience helper must read the existing row
 * first and write it back with the one field changed — it must not build a
 * partial object, or it will silently wipe whatever it omits.
 *
 * Every write is audited, even though the charter is unaffected: `endpoint`
 * and `credentialRef` can redirect a permitted connection to a different host
 * or secret, which is a real change in where trust is placed, so it must be
 * at least as visible as a kill switch trip. The insert and the audit append
 * run in one transaction — an append that fails must roll the write back, or
 * a redirect could commit with nothing recording it, which would make the
 * audit trail a mitigation in name only.
 *
 * `by` is required, not defaulted, for the same reason `trip()` and
 * `release()` in `governance/killswitch.ts` require it: an automated status
 * flip and a human-initiated redirect must not be recorded as the same
 * anonymous "human" actor.
 */
export async function upsertBinding(
  binding: ConnectionBinding,
  options: { businessId?: string; db?: Queryable; charterVersion?: string; by: string },
): Promise<void> {
  const parsed = ConnectionBinding.parse(binding);
  const businessId = options.businessId ?? config.businessId;

  // The insert and the audit append must land on the same connection inside
  // one transaction, or (a) a crash between them lets a redirect commit
  // unaudited, and (b) `appendAudit`'s advisory lock — transaction-scoped —
  // would be taken and released inside a single statement, letting two
  // concurrent appends read the same chain tail and fork it. When the caller
  // supplies `options.db`, it is trusted to already be such a handle and the
  // caller owns committing or rolling it back; otherwise a transaction is
  // opened here and used for both statements.
  const write = async (tx: Queryable): Promise<void> => {
    await tx.query(
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
        businessId,
        parsed.system,
        parsed.status,
        parsed.endpoint,
        parsed.credentialRef,
        parsed.lastOkAt,
        parsed.lastError,
      ],
    );

    await appendAudit(
      {
        actor: 'human',
        onBehalfOf: options.by,
        kind: 'connection_binding',
        charterVersion: options.charterVersion ?? 'unknown',
        provenance: 'boss',
        inputHash: canonicalHash(parsed),
        reason: `connection binding for "${parsed.system}" set to status "${parsed.status}" by ${options.by}`,
      },
      { businessId, tx },
    );
  };

  if (options.db) {
    await write(options.db);
  } else {
    await withTransaction((client) => write(client));
  }
}
