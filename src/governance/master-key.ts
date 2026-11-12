/**
 * The key lives in a file, and is read once into process memory.
 *
 * NOT an environment variable, and the difference is not stylistic: the
 * environment is inherited by child processes, appears in crash dumps, and
 * reaches logs. This project already guards against exactly that elsewhere —
 * the curator's SDK call is given `env: { PATH }` and nothing else — so a
 * master key in the environment would be the one secret handled less
 * carefully than the model prompts.
 */
import { readFile, stat } from 'node:fs/promises';
import type { Queryable } from '../db/pool.js';
import { decryptSecret, encryptSecret, type Sealed } from './secret-cipher.js';

export const KEY_BYTES = 32;

/**
 * Every failure to obtain a usable key. One error type, because the caller's
 * response to all of them is identical: refuse to start.
 */
export class MasterKeyError extends Error {}

/**
 * The AAD under which the key-check value is sealed. Not a real secret ref —
 * it never touches the `credentials` table — but the cipher requires an AAD
 * for every call, and this is a fixed, known one so the check value proves
 * exactly one thing: the key in the file is the key that sealed this row.
 *
 * Lowercase and hyphenated on purpose, not merely as a naming convention.
 * `CREDENTIAL_REF_PATTERN` (`src/orchestrator/credentials.ts`) is
 * `/^[A-Z0-9_]+$/` — uppercase letters, digits, underscores only — so a real
 * credential ref can never equal this string. That makes the two AAD domains
 * disjoint by construction: no credential a customer stores can ever share
 * this row's authenticated data, which is exactly the property the cipher's
 * AAD binding exists to give every row. A blocklist ("refuse the ref
 * `KEY_CHECK`") would have been a negative control instead, and this
 * codebase has already been bitten three times by "everything that is not
 * X". Do not "tidy" this back to uppercase — that would put it back inside
 * the credential ref's own alphabet.
 */
const KEY_CHECK_REF = 'key-check';
const KEY_CHECK_PLAINTEXT = 'credential-broker-key-check';

/**
 * The business half of the key check's authenticated data, for every row the
 * server writes. The key is the server's, not any business's (spec §5.9), and
 * `''` is a value no business id (`^[a-z0-9-]{3,63}$`) can take — so the check
 * value can never share its authenticated data with a business's own
 * `key-check`-shaped AAD, even in principle.
 *
 * A row carried over from before the key moved to the server (migration 067)
 * was sealed under the business the installation was configured for, and
 * names it in `check_business_id`; `verifyKeyState` opens each row under the
 * business it names. The next `create`/`rotate` replaces it with one sealed
 * under this value.
 */
const SERVER_KEY_CHECK_BUSINESS = '';

interface KeyStateRow {
  check_nonce: Buffer;
  check_value: Buffer;
  check_business_id: string;
}

async function readKeyBytes(path: string): Promise<Buffer> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    throw new MasterKeyError(`לא ניתן לקרוא את קובץ המפתח (${path})`, { cause: error });
  }
  if (raw.length !== KEY_BYTES) {
    throw new MasterKeyError(
      `קובץ המפתח באורך שגוי: התקבלו ${raw.length} בתים, נדרשים ${KEY_BYTES}`,
    );
  }
  return raw;
}

/**
 * Spec §4.2 — a key file readable by group or other is not protected. Pure
 * function of the mode bits, deliberately separated from `fs.stat` so the
 * decision itself ("is this mode too open?") is fully unit-testable on every
 * platform, including the one (Windows) where a real file's `mode` cannot be
 * trusted to carry these bits at all. What is NOT tested here — and cannot
 * be, on this platform — is whether `fs.stat().mode` actually reports them;
 * that is Node's contract with POSIX, not this project's, and is covered
 * instead by the filesystem test in `master-key.test.ts`.
 */
export function isModeTooOpen(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

/**
 * Windows does not expose POSIX group/other permission bits through
 * `fs.stat`: `mode` there reflects only a read-only attribute, not who else
 * can read the file. A check written against POSIX bits would either always
 * pass (useless) or always misfire (a false refusal on every Windows
 * install), so it is skipped on that platform — stated here and again at the
 * call site, not silently omitted.
 */
async function assertKeyFilePermissions(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const info = await stat(path);
  if (isModeTooOpen(info.mode)) {
    throw new MasterKeyError(
      `קובץ המפתח פתוח לקריאה למשתמשים או לקבוצה נוספים (${path}) — יש להריץ chmod 600`,
    );
  }
}

/**
 * Read the master key from disk. Refuses — never returns a usable-but-wrong
 * value — when the file is missing, the wrong length, or (on POSIX) too
 * widely readable. The length check runs before the permission check so a
 * malformed file is reported as malformed, not as a permissions problem.
 */
export async function loadMasterKey(path: string): Promise<Buffer> {
  const key = await readKeyBytes(path);
  await assertKeyFilePermissions(path);
  return key;
}

/**
 * Seal the key-check plaintext with `key` and store it as the server's one
 * row (`server_key_state`, spec §5.9). `db` is required: the caller says which
 * connection — the platform pool from the key CLI, a test's own — and there is
 * no business to default to, because the key is not any business's.
 */
export async function writeKeyState(key: Buffer, keyId: string, db: Queryable): Promise<void> {
  const sealed = encryptSecret(KEY_CHECK_PLAINTEXT, key, {
    businessId: SERVER_KEY_CHECK_BUSINESS,
    ref: KEY_CHECK_REF,
  });

  await db.query(
    `INSERT INTO server_key_state (singleton, key_id, check_nonce, check_value, check_business_id)
     VALUES (true, $1, $2, $3, $4)
     ON CONFLICT (singleton) DO UPDATE
       SET key_id = EXCLUDED.key_id,
           check_nonce = EXCLUDED.check_nonce,
           check_value = EXCLUDED.check_value,
           check_business_id = EXCLUDED.check_business_id,
           created_at = now()`,
    [keyId, sealed.nonce, sealed.ciphertext, SERVER_KEY_CHECK_BUSINESS],
  );
}

/**
 * Spec §5.1 — catch a wrong or damaged key at startup, before any real
 * secret is touched. Without this, a replaced key file surfaces as a
 * customer's email failing at three in the morning rather than as a refusal
 * to start.
 *
 * No row at all means a fresh install with nothing to verify against yet —
 * that resolves quietly, not as a failure. A row that exists but does not
 * open under `key` throws: the check value is not a secret, so what it
 * proves by opening (or failing to) is only "the key in the file is the key
 * that sealed the rows this installation already has."
 *
 * The row is the SERVER's (spec §5.9), so every business passes or fails the
 * same check — a business created yesterday, with no key state of its own,
 * is checked against the one key the server holds. `db` is required and is
 * used as given: a dashboard request passes its own request connection, and
 * this function must never acquire a second one beside it (pool.ts's
 * hold-and-wait note).
 */
export async function verifyKeyState(key: Buffer, db: Queryable): Promise<void> {
  const { rows } = await db.query<KeyStateRow>(
    'SELECT check_nonce, check_value, check_business_id FROM server_key_state',
  );
  const row = rows[0];
  if (!row) return;

  const sealed: Sealed = { ciphertext: row.check_value, nonce: row.check_nonce };
  const opened = decryptSecret(sealed, key, { businessId: row.check_business_id, ref: KEY_CHECK_REF });
  if (opened === null) {
    throw new MasterKeyError(
      'המפתח שסופק אינו תואם למפתח שהצפין את הסודות של ההתקנה הזו — העלייה מסורבת',
    );
  }
}
