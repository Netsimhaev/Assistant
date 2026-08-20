import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import { hashPassword, verifyPassword, revokeAllSessions, DECOY_HASH, DECOY_SALT } from './auth.js';

/** 128 bits of code, encoded as hex — the same size as a session token. */
const CODE_BYTES = 16;
const DEFAULT_CODE_COUNT = 8;

/**
 * Recovery redemption's own throttle, deliberately separate from password
 * login's `failed_attempts`/`locked_until` (see the docblock on
 * `redeemRecoveryCode`). A lockout exists to protect a *low-entropy* secret
 * from repeated guessing; a 128-bit recovery code cannot be guessed at any
 * rate, so this threshold is not defending a secret — it caps how much CPU
 * an attacker can force this endpoint to spend running its (deliberately
 * expensive) up-to-eight `scrypt` comparisons over and over. Ten attempts
 * before a one-minute pause is real friction against a script hammering the
 * endpoint, and effectively invisible to an owner typing one of eight
 * printed codes by hand — nobody fat-fingers a recovery code ten times.
 */
const RECOVERY_MAX_FAILED = 10;
const RECOVERY_LOCK_MINUTES = 1;

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
 * The same read-SQL-only increment login uses, but against recovery's own
 * columns: a read-modify-write in JavaScript would let concurrent wrong
 * guesses all read the same stale count and each write back count + 1, so
 * the counter would advance by one instead of by N and the throttle would
 * stop existing under concurrency. `recovery_failed_attempts =
 * recovery_failed_attempts + 1` computed inside a single UPDATE is safe
 * because Postgres holds the row lock for the statement's duration.
 */
async function recordFailedAttempt(
  db: Queryable,
  businessId: string,
  username: string,
  now: Date,
): Promise<void> {
  const lockUntilIfThresholdReached = new Date(now.getTime() + RECOVERY_LOCK_MINUTES * 60_000);
  await db.query(
    `UPDATE dashboard_users
        SET recovery_failed_attempts = recovery_failed_attempts + 1,
            recovery_locked_until = CASE
              WHEN recovery_failed_attempts + 1 >= $3 THEN $4
              ELSE recovery_locked_until
            END
      WHERE business_id = $1 AND username = $2`,
    [businessId, username, RECOVERY_MAX_FAILED, lockUntilIfThresholdReached],
  );
}

/**
 * Redeem one recovery code.
 *
 * Tries every stored code's hash for the account, unused or not, and never
 * stops at the first match: breaking out early would let response time leak
 * which code — or which position — matched. Eight `scrypt` calls (the
 * default issue count) is the deliberate cost, not something to optimise
 * away; the slowness is what makes guessing codes expensive. When the
 * account has no codes issued at all, the same number of decoy `scrypt`
 * calls run against `DECOY_HASH`/`DECOY_SALT` instead — otherwise that case
 * returns after zero real work while an account with codes always runs
 * several, and the gap tells an observer whether recovery was ever set up
 * for a given username.
 *
 * The claim itself is `UPDATE ... WHERE code_id = $1 AND used_at IS NULL
 * RETURNING code_id` — one conditional statement, so two concurrent
 * redemptions of the same code cannot both succeed. Whichever loses the race
 * sees the row already spent and is told `already_used`, exactly as if it
 * had arrived a moment later.
 *
 * Throttled by its own lock (`recovery_failed_attempts`/
 * `recovery_locked_until`, see the constants above), not by password
 * login's. The two must not share a budget: a recovery code is 128 random
 * bits and cannot be guessed at any rate, so spending login's budget on it
 * buys no security — and doing so would let anyone who knows the username
 * (effectively public on a single-tenant install) re-lock password login
 * indefinitely with trivial wrong-code traffic, and, worse, would leave an
 * owner who mistyped their password five times unable to use the recovery
 * codes that exist for exactly that moment. A locked recovery budget refuses
 * before touching any code hash, reported as `no_match` rather than a
 * distinct `locked` code — the interface has no third case, and leaking
 * lock state to whoever is submitting codes would hand an attacker a free
 * signal.
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

  const { rows: userRows } = await db.query<{ recovery_locked_until: Date | null }>(
    `SELECT recovery_locked_until FROM dashboard_users WHERE business_id = $1 AND username = $2`,
    [businessId, input.username],
  );
  let lockedUntil = userRows[0]?.recovery_locked_until ?? null;

  // Lazily clear an expired lock, same pattern as login: the WHERE clause
  // re-checks `recovery_locked_until <= $3` in Postgres rather than trusting
  // the JS-side read, so a concurrent failed attempt that re-locked the
  // account between the SELECT and this UPDATE leaves the fresh lock intact
  // instead of being clobbered a moment after it was set.
  if (lockedUntil !== null && lockedUntil.getTime() <= now.getTime()) {
    const cleared = await db.query(
      `UPDATE dashboard_users SET recovery_failed_attempts = 0, recovery_locked_until = NULL
        WHERE business_id = $1 AND username = $2 AND recovery_locked_until <= $3`,
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
  if (codeRows.length === 0) {
    // No codes ever issued for this username: pay the same decoy cost login
    // pays for "no such user", so the timing here matches an account that
    // does have codes to try.
    for (let i = 0; i < DEFAULT_CODE_COUNT; i += 1) {
      await verifyPassword(input.code, DECOY_HASH, DECOY_SALT);
    }
  } else {
    for (const row of codeRows) {
      const record = toRecoveryCodeRecord(row);
      // Sequential and deliberate: see the function docblock above.
      const isMatch = await verifyPassword(input.code, record.codeHash, record.codeSalt);
      if (isMatch) {
        matched = record;
      }
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

    // Clears recovery's own throttle — not password login's, which this
    // function never touches in either direction.
    await tx.query(
      `UPDATE dashboard_users SET recovery_failed_attempts = 0, recovery_locked_until = NULL
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
