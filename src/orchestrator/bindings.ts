import type pg from 'pg';
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
  provider: string | null;
  last_ok_at: Date | null;
  last_error: string | null;
}

function toBinding(row: BindingRow): ConnectionBinding {
  return ConnectionBinding.parse({
    system: row.system,
    status: row.status,
    endpoint: row.endpoint,
    credentialRef: row.credential_ref,
    provider: row.provider,
    lastOkAt: row.last_ok_at?.toISOString() ?? null,
    lastError: row.last_error,
  });
}

export async function loadBindings(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ConnectionBinding[]> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<BindingRow>(
    `SELECT system, status, endpoint, credential_ref, provider, last_ok_at, last_error
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
 * anonymous "human" actor. It must also be non-empty — an unvalidated
 * required field is a required field in name only. (On the transaction point
 * below, `release()` follows this same atomic-with-rollback shape. `trip()`
 * deliberately does not: its write commits even if the audit append fails,
 * because rolling back an emergency stop over an audit failure would be
 * worse than a stop with a late or manually reconstructed record. See the
 * docblock on `trip()` for why that asymmetry is intentional.)
 *
 * `options.db`, when supplied, must be a real `pg.PoolClient` already inside
 * a transaction the caller owns — not just anything with a `.query` method.
 * A bare `pg.Pool` satisfies a looser `Queryable` type structurally, which
 * would silently defeat the atomicity this function exists to provide, so
 * the type itself rules it out.
 */
/**
 * Record whether one system's connection just worked or just failed.
 *
 * `last_ok_at` and `last_error` have existed on this table since it was
 * created, validated by `ConnectionBinding` and returned by `loadBindings`,
 * with no production writer at all — the two seed scripts that touched them
 * only ever wrote `null`. This is that writer, and `performStep`
 * (`run-plan.ts`), which calls it right after `callWithDeadline` resolves,
 * is its reader-in-waiting: the connector layer is exactly what knows
 * whether a call just landed or just failed, and nowhere else does.
 *
 * **Display, not control.** This function must never be able to fail the
 * step that just ran — a bookkeeping UPDATE losing its connection to the
 * pool must not turn a step that actually succeeded into one reported as
 * failed. The caller wraps this in its own `.catch`; nothing here throws
 * past that boundary on purpose, but the caller does not rely on this
 * function being silent — it guards regardless.
 *
 * **`last_error` carries only what the ADAPTER classified.** `errorCode`
 * and `errorMessage` are `AdapterResult`'s own failure fields — never a
 * provider's raw response body, and never anything derived from a
 * credential. This is a plain `text` column, so the rule an audit row's
 * `reason` already holds applies here without exception: a secret written
 * to a text column is a secret leaked to every future reader of it, forever
 * (`audit_log` is append-only; this column is not, but nothing here assumes
 * that as a safety net).
 *
 * **A failure never moves `status`.** `status` answers "does the owner (or
 * an explicit health check) currently trust this connection" — a question
 * with a human or an operator behind it. One call's outcome is not that
 * answer: a transient network fault may clear itself in five minutes, the
 * exact loop the scheduler already runs, and a *terminal* authentication
 * failure is a fact about the GRANT, not the connection — the token service
 * already marks the grant as needing re-authorisation, and that is where it
 * belongs. Loading `status` with a second meaning here would make one field
 * answer two different questions that disagree in exactly the cases that
 * matter. Only `upsertBinding`, driven by a human or a health check, moves
 * `status`.
 *
 * `businessId` is required, with no default, for the same reason
 * `CredentialSource.resolve` and `upsertBinding` both require it: a caller
 * that could omit it would read the omission as "the business in the
 * configuration," which is exactly how one customer's connection history
 * ends up recorded against another's.
 */
export async function recordBindingOutcome(
  input: { businessId: string; system: string; ok: boolean; errorCode?: string; errorMessage?: string },
  options: { db?: Queryable } = {},
): Promise<void> {
  const db = options.db ?? getPool();
  const detail = input.ok ? null : `${input.errorCode ?? 'unknown'} — ${input.errorMessage ?? ''}`.trim();
  await db.query(
    `UPDATE connection_bindings
        SET last_ok_at = CASE WHEN $3 THEN now() ELSE last_ok_at END,
            last_error = $4
      WHERE business_id = $1 AND system = $2`,
    [input.businessId, input.system, input.ok, detail],
  );
}

export async function upsertBinding(
  binding: ConnectionBinding,
  options: { businessId?: string; db?: pg.PoolClient; charterVersion?: string; by: string },
): Promise<void> {
  if (options.by.trim().length === 0) {
    throw new Error('upsertBinding: "by" must not be empty');
  }
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
         (business_id, system, status, endpoint, credential_ref, provider, last_ok_at, last_error, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (business_id, system) DO UPDATE
         SET status = EXCLUDED.status,
             endpoint = EXCLUDED.endpoint,
             credential_ref = EXCLUDED.credential_ref,
             provider = EXCLUDED.provider,
             last_ok_at = EXCLUDED.last_ok_at,
             last_error = EXCLUDED.last_error,
             updated_at = now()`,
      [
        businessId,
        parsed.system,
        parsed.status,
        parsed.endpoint,
        parsed.credentialRef,
        parsed.provider,
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
