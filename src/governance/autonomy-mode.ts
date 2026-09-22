/**
 * The owner's dial: how much freedom the assistant may earn.
 *
 * This is deliberately NOT a second permission system beside the charter.
 * The charter already caps every action class and is signed; this decides
 * one thing only — how low the earned ramp may sit (spec §3.1) — and the
 * gate combines the two by minimum, so the dial can never widen what the
 * owner signed.
 *
 * It needs no signature for that reason. What it does get is an audit row
 * naming both levels and the person, because a change to how much the
 * assistant may do on her own is exactly the kind of fact a business needs
 * to be able to reconstruct later.
 */
import { z } from 'zod';
import { config } from '../config.js';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import type { AutonomyLevel } from '../domain/trust.js';

export const AutonomyMode = z.enum(['off', 'ask', 'learn']);
export type AutonomyMode = z.infer<typeof AutonomyMode>;

/** What a new install has, and what an unreadable value falls back to. */
const MODE_FLOOR: AutonomyMode = 'off';

/**
 * The window the ramp may sit in, for each mode.
 *
 * BOTH ends, and the ceiling is the half that makes the switch honest. With a
 * floor alone, `off` could not pull back a class that had already been
 * promoted: the stored level would simply win, and a switch the owner reads
 * as "stop" would leave her acting. `off` therefore pins everything at
 * `draft_only`, `ask` pins everything at `approve_required` — she asks every
 * time, which is what that label says — and only `learn` opens a range for
 * the measurement to move inside.
 *
 * This is a clamp and not a grant. The ramp remains one of five ceilings
 * `effectiveAutonomy` combines by minimum, so nothing here can exceed the
 * signed charter; `ramp-floor.test.ts` proves that through a real gate
 * decision rather than asserting it.
 */
export function rampBoundsForMode(
  mode: AutonomyMode,
): { floor: AutonomyLevel; ceiling: AutonomyLevel } {
  if (mode === 'off') return { floor: 'draft_only', ceiling: 'draft_only' };
  if (mode === 'ask') return { floor: 'approve_required', ceiling: 'approve_required' };
  return { floor: 'approve_required', ceiling: 'auto_notify' };
}

export async function loadAutonomyMode(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AutonomyMode> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ mode: string }>(
    'SELECT mode FROM autonomy_mode WHERE business_id = $1',
    [options.businessId ?? config.businessId],
  );

  const stored = rows[0]?.mode;
  if (stored === undefined) return MODE_FLOOR;

  // Parsed, not cast — the column is TEXT, so a rollback or a hand-edited row
  // can hold a value this build cannot rank. The same decision `loadRampLevel`
  // makes for the same reason: a value nobody can read is never permissive.
  const parsed = AutonomyMode.safeParse(stored);
  return parsed.success ? parsed.data : MODE_FLOOR;
}

/**
 * Writes the row and its audit entry as one transaction — the same shape
 * `move()` in `orchestrator/promote.ts` uses, and for the identical reason.
 * `appendAudit` takes a per-business advisory lock that contends exactly
 * when the system is busy; two separate commits would let the dial move —
 * possibly to `learn`, opening every class to earned promotion — while the
 * audit row describing who moved it and from where simply never lands. A
 * failed audit here must roll the mode back, not leave it changed and mute.
 *
 * The transaction is opened here, on the pool, exactly as `move()` in
 * `orchestrator/promote.ts` opens its own rather than threading
 * `options.db`: that parameter points the read in `loadAutonomyMode` at a
 * connection, and the one production caller (`dashboard/server.ts`) never
 * sets it.
 */
export async function setAutonomyMode(
  mode: AutonomyMode,
  by: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;

  await withTransaction(async (tx) => {
    const previous = await loadAutonomyMode({ businessId, db: tx });

    await tx.query(
      `INSERT INTO autonomy_mode (business_id, mode, updated_at, updated_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (business_id)
       DO UPDATE SET mode = EXCLUDED.mode, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [businessId, mode, by],
    );

    await appendAudit(
      {
        actor: 'human',
        onBehalfOf: by,
        kind: 'autonomy_change',
        charterVersion: 'unknown',
        provenance: 'boss',
        inputHash: canonicalHash({ from: previous, to: mode }),
        reason: `רמת החופש שונתה מ-${previous} ל-${mode} על ידי ${by}`,
      },
      { businessId, tx },
    );
  });
}
