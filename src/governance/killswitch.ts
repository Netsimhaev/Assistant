import { config } from '../config.js';
import type { AgentId } from '../domain/audit.js';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';

export type Department =
  | 'front_office'
  | 'knowledge'
  | 'operations'
  | 'production'
  | 'governance';

export const AGENT_DEPARTMENT: Record<AgentId, Department> = {
  'intake.triage': 'front_office',
  'comms.email': 'front_office',
  'comms.whatsapp': 'front_office',
  'sched.meetings': 'front_office',
  'know.reader': 'knowledge',
  'know.memory': 'knowledge',
  'know.digest': 'knowledge',
  'ops.tasks': 'operations',
  'ops.web': 'operations',
  'ops.systems': 'operations',
  'prod.docs': 'production',
  'prod.media': 'production',
  'gov.charter': 'governance',
  'gov.risk': 'governance',
  'gov.verify': 'governance',
};

/**
 * `all` stops everything. `outbound` lets reading and analysis continue but
 * nothing leaves the building. A department scope stops one department.
 */
export type KillScope = 'all' | 'outbound' | Department;

export interface KillSwitchState {
  scope: KillScope;
  tripped: boolean;
  trippedBy: string | null;
  trippedAt: string | null;
  reason: string | null;
}

interface KillRow {
  scope: string;
  tripped: boolean;
  tripped_by: string | null;
  tripped_at: Date | null;
  reason: string | null;
}

/**
 * Trip a kill switch.
 *
 * The state lives in Postgres rather than in memory precisely so it survives a
 * process restart — a stop that a crash-and-respawn would clear is not a stop.
 *
 * DELIBERATELY NOT ATOMIC WITH ITS AUDIT ENTRY, unlike every other write in
 * this codebase (`upsertBinding`, `release()` below). The kill-switch write
 * commits on its own first; the audit append happens after, on its own
 * connection. If the append fails, this throws — loudly, saying the stop
 * *is* in force but was not recorded — and does **not** undo the write.
 *
 * This looks like the same defect `release()` and `upsertBinding` had before
 * they were made transactional. It is not, and "fixing" it back to
 * atomic-with-rollback would reintroduce a real bug: the kill switch is the
 * control whose entire job is to work when everything else already has. The
 * audit advisory lock is exactly the thing likely to be contended when
 * someone reaches for the stop, because contention means the system is busy,
 * which is when a stop is needed. Of the two failure directions —
 * "stopped, audit missing, throw raises the alarm" versus "still running, no
 * record, no alarm" — only the first is defensible. A trip that rolled back
 * because it could not also write an audit row would silently keep an
 * emergency stop from taking effect at the worst possible moment.
 *
 * `release()` is intentionally the opposite: releasing without a record is
 * the dangerous direction there, so `release()` rolls back and refuses to
 * release when its audit append fails. The asymmetry between the two
 * functions is the point, not an inconsistency to smooth over.
 *
 * Do not pass a caller-owned transaction into this function (there is
 * currently no such option, and none should be added casually): the audit
 * advisory lock is transaction-scoped, so calling `trip()` from inside a
 * transaction that has already appended an audit entry this business would
 * block on that lock with no deadlock detection across separate connections.
 * No caller does this today.
 */
export async function trip(
  scope: KillScope,
  by: string,
  reason: string,
  options: { businessId?: string; charterVersion?: string } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;

  await getPool().query(
    `INSERT INTO kill_switch (business_id, scope, tripped, tripped_by, tripped_at, reason, updated_at)
     VALUES ($1, $2, true, $3, now(), $4, now())
     ON CONFLICT (business_id, scope)
     DO UPDATE SET tripped = true, tripped_by = EXCLUDED.tripped_by,
                   tripped_at = now(), reason = EXCLUDED.reason,
                   released_by = NULL, released_at = NULL, updated_at = now()`,
    [businessId, scope, by, reason],
  );

  try {
    await appendAudit(
      {
        actor: 'human',
        onBehalfOf: by,
        kind: 'kill_switch',
        charterVersion: options.charterVersion ?? 'unknown',
        provenance: 'boss',
        inputHash: canonicalHash({ scope, action: 'trip' }),
        reason: `kill switch TRIPPED on scope "${scope}" by ${by}: ${reason}`,
      },
      { businessId },
    );
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `kill switch scope "${scope}" IS TRIPPED (the stop is in force) but the audit ` +
        `entry recording it failed to write: ${cause}. The system is stopped; the ` +
        `record of who stopped it and why is missing and must be reconstructed manually.`,
    );
  }
}

/**
 * Release a kill switch. Requires an explicit human action and produces its own
 * audit entry with a reason — resuming is as accountable as stopping.
 *
 * The update and its audit entry share one transaction for the same reason as
 * `trip()`. The "nothing was tripped" check runs first and throws inside the
 * transaction, before any audit row is written, so the throw rolls back
 * cleanly and the trail never gains a RELEASED entry for an event that never
 * happened.
 */
export async function release(
  scope: KillScope,
  by: string,
  reason: string,
  options: { businessId?: string; charterVersion?: string } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;

  await withTransaction(async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE kill_switch
          SET tripped = false, released_by = $3, released_at = now(), updated_at = now()
        WHERE business_id = $1 AND scope = $2 AND tripped = true`,
      [businessId, scope, by],
    );

    // Nothing was tripped, so nothing was released. Writing the audit entry
    // anyway put a permanent, hash-chained "RELEASED" record in the trail for
    // an event that never happened — and the trail is the only thing anyone
    // has to reconstruct who stopped the system and when.
    if ((rowCount ?? 0) === 0) {
      throw new Error(`kill switch scope "${scope}" is not tripped; nothing to release`);
    }

    await appendAudit(
      {
        actor: 'human',
        onBehalfOf: by,
        kind: 'kill_switch',
        charterVersion: options.charterVersion ?? 'unknown',
        provenance: 'boss',
        inputHash: canonicalHash({ scope, action: 'release' }),
        reason: `kill switch RELEASED on scope "${scope}" by ${by}: ${reason}`,
      },
      { businessId, tx },
    );
  });
}

export async function activeScopes(
  businessId: string = config.businessId,
  db: Queryable = getPool(),
): Promise<KillSwitchState[]> {
  const { rows } = await db.query<KillRow>(
    'SELECT scope, tripped, tripped_by, tripped_at, reason FROM kill_switch WHERE business_id = $1 AND tripped = true',
    [businessId],
  );
  return rows.map((row) => ({
    scope: row.scope as KillScope,
    tripped: row.tripped,
    trippedBy: row.tripped_by,
    trippedAt: row.tripped_at?.toISOString() ?? null,
    reason: row.reason,
  }));
}

export interface KillCheck {
  blocked: boolean;
  scope?: KillScope;
  reason?: string;
}

/**
 * The check run at the top of every gate and before every queue dequeue.
 *
 * `isOutbound` matters because the `outbound` scope is the useful middle
 * setting: the assistant keeps reading, summarising and preparing, and simply
 * cannot send. Read-only work under an outbound stop is intentional, not a gap.
 */
export async function checkKillSwitch(
  agent: AgentId,
  isOutbound: boolean,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<KillCheck> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const department = AGENT_DEPARTMENT[agent];

  const relevant: KillScope[] = ['all', department];
  if (isOutbound) relevant.push('outbound');

  const { rows } = await db.query<KillRow>(
    `SELECT scope, tripped, tripped_by, tripped_at, reason
       FROM kill_switch
      WHERE business_id = $1 AND tripped = true AND scope = ANY($2::text[])
      ORDER BY CASE scope WHEN 'all' THEN 0 WHEN 'outbound' THEN 1 ELSE 2 END
      LIMIT 1`,
    [businessId, relevant],
  );

  const row = rows[0];
  if (!row) return { blocked: false };

  return {
    blocked: true,
    scope: row.scope as KillScope,
    reason: row.reason ?? 'no reason recorded',
  };
}
