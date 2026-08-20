import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import { hashPassword, verifyPassword, revokeAllSessions, MAX_FAILED, LOCK_MINUTES } from './auth.js';

/** 128 bits of code, encoded as hex — the same size as a session token. */
const CODE_BYTES = 16;
const DEFAULT_CODE_COUNT = 8;

interface RecoveryCodeRow {
  code_id: string;
  code_hash: string;
  code_salt: string;
  used_at: Date | null;
}

interface RecoveryCodeRecord {
  codeId: string;
  codeHash: string;
  codeSalt: string;
  usedAt: Date | null;
}

function toRecoveryCodeRecord(row: RecoveryCodeRow): RecoveryCodeRecord {
  return {
    codeId: row.code_id,
    codeHash: row.code_hash,
    codeSalt: row.code_salt,
    usedAt: row.used_at,
  };
}

/**
 * Eight single-use codes, shown once and never stored.
 *
 * 128 bits from a cryptographic source, not `Math.random`, which is seeded
 * predictably and is not a security primitive in any runtime. Each code is
 * hashed with its own salt exactly like a password — `dashboard_recovery_codes`
 * holds the hash, never the code, so a leaked backup cannot be read back into
 * working credentials.
 */
export async function issueRecoveryCodes(input: {
  username: string;
  businessId?: string;
  count?: number;
}): Promise<string[]> {
  const businessId = input.businessId ?? config.businessId;
  const count = input.count ?? DEFAULT_CODE_COUNT;

  const plainCodes = Array.from({ length: count }, () => randomBytes(CODE_BYTES).toString('hex'));
  const hashed = await Promise.all(plainCodes.map((code) => hashPassword(code)));

  await withTransaction(async (tx) => {
    // Re-issuing voids every older code first: two valid sets in circulation
    // means a code the owner believes they burned is still live. The DELETE
    // and the inserts share a transaction so a crash mid-batch cannot leave
    // the account with neither the old set nor a complete new one.
    await tx.query(
      `DELETE FROM dashboard_recovery_codes WHERE business_id = $1 AND username = $2`,
      [businessId, input.username],
    );
    for (const { hash, salt } of hashed) {
      const codeId = randomBytes(CODE_BYTES).toString('hex');
      await tx.query(
        `INSERT INTO dashboard_recovery_codes (code_id, business_id, username, code_hash, code_salt)
         VALUES ($1, $2, $3, $4, $5)`,
        [codeId, businessId, input.username, hash, salt],
      );
    }
  });

  return plainCodes;
}

/**
 * The same read-SQL-only increment login uses: a read-modify-write in
 * JavaScript would let concurrent wrong guesses all read the same stale
 * count and each write back count + 1, so the counter would advance by one
 * instead of by N and the lockout would stop existing under concurrency.
 * `failed_attempts = failed_attempts + 1` computed inside a single UPDATE is
 * safe because Postgres holds the row lock for the statement's duration.
 *
 * Sharing this with login's own increment (same columns, same MAX_FAILED,
 * same LOCK_MINUTES, imported from auth.ts rather than redefined here) is
 * the point: guessing recovery codes must spend down the identical budget
 * as guessing passwords, or it is a second, unlimited door next to the
 * first one's lock.
 */
async function recordFailedAttempt(
  db: Queryable,
  businessId: string,
  username: string,
  now: Date,
): Promise<void> {
  const lockUntilIfThresholdReached = new Date(now.getTime() + LOCK_MINUTES * 60_000);
  await db.query(
    `UPDATE dashboard_users
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE
              WHEN failed_attempts + 1 >= $3 THEN $4
              ELSE locked_until
            END
      WHERE business_id = $1 AND username = $2`,
    [businessId, username, MAX_FAILED, lockUntilIfThresholdReached],
  );
}

/**
 * Redeem one recovery code.
 *
 * Tries every stored code's hash for the account, unused or not, and never
 * stops at the first match: breaking out early would let response time leak
 * which code — or which position — matched. Eight `scrypt` calls (the
 * default issue count) is the deliberate cost, not something to optimise
 * away; the slowness is what makes guessing codes expensive.
 *
 * The claim itself is `UPDATE ... WHERE code_id = $1 AND used_at IS NULL
 * RETURNING code_id` — one conditional statement, so two concurrent
 * redemptions of the same code cannot both succeed. Whichever loses the race
 * sees the row already spent and is told `already_used`, exactly as if it
 * had arrived a moment later.
 *
 * A locked account (same lock login enforces) refuses before touching any
 * code hash. It is reported as `no_match` rather than a distinct `locked`
 * code: the interface has no third case, and giving lock state away to
 * whoever is submitting codes would hand an attacker a free signal the
 * password path already declines to leak past 'locked' vs 'bad_credentials'
 * only being visible to someone who already knows the account exists.
 *
 * `sourceAddress` is supplied by the caller because this function has no
 * HTTP context of its own — it is never invented here, only carried through
 * to the audit entry that names where the redemption came from.
 */
export async function redeemRecoveryCode(input: {
  username: string;
  code: string;
  businessId?: string;
  sourceAddress?: string;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; code: 'no_match' | 'already_used' }> {
  const businessId = input.businessId ?? config.businessId;
  const now = input.now ?? new Date();
  const db = getPool();

  const { rows: userRows } = await db.query<{ locked_until: Date | null }>(
    `SELECT locked_until FROM dashboard_users WHERE business_id = $1 AND username = $2`,
    [businessId, input.username],
  );
  let lockedUntil = userRows[0]?.locked_until ?? null;

  // Lazily clear an expired lock, same as login: the WHERE clause re-checks
  // `locked_until <= $3` in Postgres rather than trusting the JS-side read,
  // so a concurrent failed attempt that re-locked the account between the
  // SELECT and this UPDATE leaves the fresh lock intact instead of being
  // clobbered a moment after it was set.
  if (lockedUntil !== null && lockedUntil.getTime() <= now.getTime()) {
    const cleared = await db.query(
      `UPDATE dashboard_users SET failed_attempts = 0, locked_until = NULL
        WHERE business_id = $1 AND username = $2 AND locked_until <= $3`,
      [businessId, input.username, now],
    );
    if ((cleared.rowCount ?? 0) > 0) {
      lockedUntil = null;
    }
  }

  if (lockedUntil !== null) {
    return { ok: false, code: 'no_match' };
  }

  const { rows: codeRows } = await db.query<RecoveryCodeRow>(
    `SELECT code_id, code_hash, code_salt, used_at
       FROM dashboard_recovery_codes
      WHERE business_id = $1 AND username = $2`,
    [businessId, input.username],
  );

  let matched: RecoveryCodeRecord | null = null;
  for (const row of codeRows) {
    const record = toRecoveryCodeRecord(row);
    // Sequential and deliberate: see the function docblock above.
    const isMatch = await verifyPassword(input.code, record.codeHash, record.codeSalt);
    if (isMatch) {
      matched = record;
    }
  }

  if (!matched) {
    await recordFailedAttempt(db, businessId, input.username, now);
    return { ok: false, code: 'no_match' };
  }

  if (matched.usedAt !== null) {
    return { ok: false, code: 'already_used' };
  }

  const matchedCodeId = matched.codeId;

  return withTransaction(async (tx) => {
    const claim = await tx.query<{ code_id: string }>(
      `UPDATE dashboard_recovery_codes SET used_at = $2
        WHERE code_id = $1 AND used_at IS NULL
        RETURNING code_id`,
      [matchedCodeId, now],
    );
    if ((claim.rowCount ?? 0) === 0) {
      // Lost the race: a concurrent redemption claimed this exact code
      // between our read above and this UPDATE.
      return { ok: false, code: 'already_used' };
    }

    // A successful redemption is exactly as trust-restoring as a correct
    // password: it clears the same failed-attempt streak and lock a correct
    // login would.
    await tx.query(
      `UPDATE dashboard_users SET failed_attempts = 0, locked_until = NULL
        WHERE business_id = $1 AND username = $2`,
      [businessId, input.username],
    );

    // Redeeming a recovery code means the owner believes their session (or
    // password) may be compromised — every open session is revoked, not
    // just the one making this request, and in the same transaction as the
    // claim so a crash cannot leave the code spent with a stolen session
    // still valid.
    await revokeAllSessions(input.username, { businessId, tx });

    await appendAudit(
      {
        actor: 'human',
        onBehalfOf: input.username,
        kind: 'incident',
        charterVersion: 'unknown',
        provenance: 'boss',
        inputHash: canonicalHash({ username: input.username, action: 'redeem_recovery_code' }),
        reason:
          `recovery code redeemed for ${input.username} from ` +
          `${input.sourceAddress ?? 'unknown source'}; all sessions revoked`,
      },
      { businessId, tx },
    );

    return { ok: true };
  });
}

interface CountRow {
  count: bigint;
}

/** How many unused codes remain — enough for the dashboard to nag about reissuing before the set runs out. */
export async function remainingCodes(
  username: string,
  options: { businessId?: string } = {},
): Promise<number> {
  const businessId = options.businessId ?? config.businessId;
  const { rows } = await getPool().query<CountRow>(
    `SELECT count(*) AS count FROM dashboard_recovery_codes
      WHERE business_id = $1 AND username = $2 AND used_at IS NULL`,
    [businessId, username],
  );
  return Number(rows[0]?.count ?? 0n);
}
