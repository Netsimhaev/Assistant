/**
 * The encrypted store: where a `credential_ref` becomes an actual secret, and
 * the only place the platform owner's secrets are written.
 *
 * This is the production implementation of `CredentialSource`
 * (`src/orchestrator/credentials.ts`); `envCredentials` beside it is kept for
 * tests only. The interface was designed for exactly this swap — no adapter
 * changes, and the secret still reaches nothing but the adapter that needs it.
 *
 * **Two independent controls stand on the same boundary** (spec §4.4, §9.1),
 * and both are here:
 *
 *  1. the query filters by business — `WHERE business_id = $1 AND ref = $2`;
 *  2. the cipher is bound to the business and the ref as authenticated data,
 *     so a row lifted from one customer into another's fails to open rather
 *     than opening wrongly.
 *
 * The second is the only control in the design that does not depend on our
 * having written the query correctly, which is why it is not folded into the
 * first. `credential-store.test.ts` exercises each on its own.
 *
 * **What the two controls are NOT is interchangeable, and that was measured
 * rather than assumed.** Deleting `AND business_id = $1` does not leak
 * anything: the cipher refuses the row the query then hands over, and every
 * "another business cannot read this" assertion stays green. What the filter
 * actually prevents is a MISS — two businesses holding the same ref, and the
 * lookup reading whichever row the query returned first — so the test that
 * isolates it asserts each business gets its OWN secret, not that it is
 * denied someone else's. The reverse direction is not symmetric: with the
 * filter in place, the row's `business_id` and the caller's are provably the
 * same value, so the cipher's binding is the only thing standing behind a
 * `WHERE` clause that is wrong in some way we have not thought of.
 */
import { config } from '../config.js';
import { acquireAdvisoryLock, getPool, withTransaction } from '../db/pool.js';
import type { Queryable } from '../db/pool.js';
import { createCredentialHandle } from '../orchestrator/adapters/types.js';
import type { CredentialHandle } from '../orchestrator/adapters/types.js';
import { CREDENTIAL_REF_PATTERN } from '../orchestrator/credentials.js';
import type { CredentialSource } from '../orchestrator/credentials.js';
import { verifyKeyState } from './master-key.js';
import { decryptSecret, encryptSecret } from './secret-cipher.js';

/**
 * A refusal by the store itself — a malformed ref, or a write attempted
 * before the installation has a key. Distinct from `MasterKeyError`, which
 * means the key on hand is not the one this installation's rows were sealed
 * with.
 *
 * No message this class carries ever names a secret's value (spec §7.3).
 */
export class CredentialStoreError extends Error {}

/**
 * The advisory-lock scope that serialises `putSecret` against key rotation
 * (`cli/secret-key.ts`). Carried from Task 4's review: `putSecret` reads the
 * live key id and inserts the sealed row in separate statements, and a
 * rotation landing between them would label a row with one key while it is
 * sealed by another — a row that opens for nobody, discovered only when a
 * customer's send fails. A lock taken on only one side of that race is not
 * a lock, so both sides take this exact string — a shared exported constant
 * rather than two literals that a future edit could let drift apart.
 */
export const ROTATION_LOCK_SCOPE = 'credential-key-rotation';

export interface SecretSummary {
  ref: string;
  keyId: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface PutSecretInput {
  /**
   * Required, with no fallback to `config.businessId` — the same rule the
   * read path states at length in `credentials.ts`. A secret written under
   * the wrong business is a secret another customer's `resolve` can reach.
   */
  businessId: string;
  ref: string;
  value: string;
  updatedBy: string;
}

export interface CredentialStoreOptions {
  db?: Queryable;
}

/** Only ever the sealed halves: no column of this row is readable as-is. */
interface SealedRow {
  ciphertext: Buffer;
  nonce: Buffer;
}

interface SummaryRow {
  ref: string;
  key_id: string;
  updated_at: Date;
  updated_by: string;
}

function toSecretSummary(row: SummaryRow): SecretSummary {
  return {
    ref: row.ref,
    keyId: row.key_id,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * Every write path validates the ref, and that is a condition something else
 * depends on rather than tidiness.
 *
 * `master-key.ts` seals its key-check value under the ref `key-check` —
 * lowercase and hyphenated — precisely because `CREDENTIAL_REF_PATTERN`
 * (`/^[A-Z0-9_]+$/`) cannot match it. That is what makes the key-check row's
 * authenticated data and every real credential's disjoint BY CONSTRUCTION
 * instead of by a rule someone has to remember. A write path that skipped
 * this check would let a secret be stored under `key-check` and quietly
 * degrade that structure into a convention.
 *
 * Thrown rather than returned as a silent no-op: an operator storing a
 * misspelled ref must learn that now, not when a customer's send fails.
 */
function assertLegalRef(ref: string): void {
  if (!CREDENTIAL_REF_PATTERN.test(ref)) {
    throw new CredentialStoreError(
      `הפניית סוד אינה בצורה חוקית (${ref}) — מותרים אותיות גדולות, ספרות וקו תחתון בלבד`,
    );
  }
}

/**
 * The key id the installation's rows are being sealed under, read from
 * `credential_key_state` rather than accepted from the caller.
 *
 * A caller that supplies its own key id can write a row labelled with one key
 * and sealed with another — a row that opens for nobody, discovered only when
 * a customer's send fails. There is no parameter for it anywhere in this
 * module.
 *
 * `businessId` here is the installation's own (`config.businessId`), not the
 * secret's: the key is per-installation and this table holds one row, so it
 * is bookkeeping rather than an authorisation decision. The read path above
 * is where an omitted business would hand one customer another's secret, and
 * that path has no default at all.
 */
async function liveKeyId(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ key_id: string }>(
    'SELECT key_id FROM credential_key_state WHERE business_id = $1',
    [config.businessId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new CredentialStoreError(
      'אין מפתח פעיל להתקנה הזו — יש ליצור מפתח לפני שמאחסנים סוד',
    );
  }
  return row.key_id;
}

/**
 * A `CredentialSource` backed by the encrypted table.
 *
 * `key` is the master key, read once at startup from its file
 * (`loadMasterKey`) and held in process memory — never in the environment,
 * which is inherited by child processes and reaches crash dumps and logs.
 */
export function storedCredentials(
  key: Buffer,
  options: CredentialStoreOptions = {},
): CredentialSource {
  return {
    async resolve(ref: string, businessId: string): Promise<CredentialHandle | null> {
      // Before any database call: a ref outside the legal shape is not a ref
      // that was ever stored, so there is nothing to look up.
      if (!CREDENTIAL_REF_PATTERN.test(ref)) return null;

      const db = options.db ?? getPool();
      const { rows } = await db.query<SealedRow>(
        'SELECT ciphertext, nonce FROM credentials WHERE business_id = $1 AND ref = $2',
        [businessId, ref],
      );
      const row = rows[0];
      if (row === undefined) return null;

      // The authenticated data is built from the business the CALLER asked
      // for — never from the row. The row's own `business_id` is not even
      // selected above, so there is nothing here to reach for by accident.
      //
      // Using the row's value would make the second control approve itself:
      // the cipher would be asked whether the bytes belong to the row they
      // were just read out of, which they always do. Measured, not assumed:
      // swapping this for `row.business_id` while the `WHERE` clause stands
      // changes no test result at all, because the filter makes the two
      // values the same string — but with the filter ALSO gone, the pair
      // hands one business another's secret in full, where the filter alone
      // or the cipher alone each refuse. That is the whole reason this reads
      // from the request rather than from the stored bytes.
      const value = decryptSecret({ ciphertext: row.ciphertext, nonce: row.nonce }, key, {
        businessId,
        ref,
      });
      // `null` for every failure, undistinguished: a wrong key, a wrong
      // business, altered bytes. The caller's correct response to all of them
      // is the same final `credential_unavailable`.
      if (value === null) return null;

      return createCredentialHandle(ref, value);
    },
  };
}

/**
 * Store one secret, replacing whatever was under that (business, ref).
 *
 * The key is verified against the installation's key state BEFORE anything is
 * sealed. Without that, a wrong key file would produce a row labelled with
 * the live key id and sealed with a different key — the exact
 * opens-for-nobody row that reading the key id from the table rather than
 * from the caller exists to prevent.
 *
 * `value` reaches the ciphertext column and nothing else: not a log line, not
 * an error message, not the returned value (there is none).
 *
 * **Reads the live key id and inserts the sealed row under
 * `ROTATION_LOCK_SCOPE`, the same advisory lock `cli/secret-key.ts`'s
 * `rotate` takes for its own re-encryption pass.** Read and insert are two
 * statements, not one — a rotation landing between them would otherwise
 * label this row with the key id rotation is about to retire while sealing
 * it with the key rotation just replaced (or the reverse), a row that opens
 * for nobody. The lock is what makes "between them" impossible rather than
 * merely unlikely: `rotate` holds the identical lock for the whole of its
 * own transaction, so the two genuinely exclude each other instead of a
 * lock on only one side of the race.
 *
 * When the caller supplies `options.db`, it is used as-is and no
 * transaction is opened here — the same convention `verifyKeyState` and
 * `liveKeyId` already follow, on the assumption (documented at every other
 * call site that does this, e.g. `sign-decision.ts`) that a caller passing
 * its own client is already inside one. No production caller does this
 * today; it exists for tests that need to observe the statements this
 * function issues.
 */
export async function putSecret(
  input: PutSecretInput,
  key: Buffer,
  options: CredentialStoreOptions = {},
): Promise<void> {
  assertLegalRef(input.ref);

  const write = async (db: Queryable): Promise<void> => {
    await acquireAdvisoryLock(db, ROTATION_LOCK_SCOPE);
    await verifyKeyState(key, { db });
    const keyId = await liveKeyId(db);

    const sealed = encryptSecret(input.value, key, {
      businessId: input.businessId,
      ref: input.ref,
    });

    await db.query(
      `INSERT INTO credentials (business_id, ref, ciphertext, nonce, key_id, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (business_id, ref) DO UPDATE
         SET ciphertext = EXCLUDED.ciphertext,
             nonce = EXCLUDED.nonce,
             key_id = EXCLUDED.key_id,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by`,
      [input.businessId, input.ref, sealed.ciphertext, sealed.nonce, keyId, input.updatedBy],
    );
  };

  if (options.db) {
    await write(options.db);
    return;
  }
  await withTransaction((tx) => write(tx));
}

/**
 * Remove one secret. Returns whether a row was actually removed, so a caller
 * can tell "gone now" from "there was nothing there" — a distinction an
 * operator removing a ref by hand needs and a bare `void` would swallow.
 */
export async function removeSecret(
  ref: string,
  businessId: string,
  options: CredentialStoreOptions = {},
): Promise<boolean> {
  assertLegalRef(ref);
  const db = options.db ?? getPool();
  const result = await db.query('DELETE FROM credentials WHERE business_id = $1 AND ref = $2', [
    businessId,
    ref,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * What this business has stored, and nothing about what it is worth.
 *
 * The `SELECT` names four columns and `ciphertext` is not among them: the
 * sealed bytes never leave this module through here, so no caller of this
 * function can print a value even by mistake. Ordered by ref so a listing is
 * stable between runs.
 */
export async function listSecretRefs(
  businessId: string,
  options: CredentialStoreOptions = {},
): Promise<SecretSummary[]> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<SummaryRow>(
    `SELECT ref, key_id, updated_at, updated_by
       FROM credentials
      WHERE business_id = $1
      ORDER BY ref`,
    [businessId],
  );
  return rows.map(toSecretSummary);
}
