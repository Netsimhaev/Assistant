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
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
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

interface KeyStateRow {
  check_nonce: Buffer;
  check_value: Buffer;
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
 * Seal the key-check plaintext with `key` and store it as the installation's
 * one row. `businessId` defaults to `config.businessId` — unlike every read
 * path for a real secret, this is bookkeeping rather than an authorisation
 * decision: the key is per-installation, the table holds exactly one row,
 * and there is no customer whose secret a default here could hand to another.
 */
export async function writeKeyState(
  key: Buffer,
  keyId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const sealed = encryptSecret(KEY_CHECK_PLAINTEXT, key, { businessId, ref: KEY_CHECK_REF });

  await db.query(
    `INSERT INTO credential_key_state (business_id, key_id, check_nonce, check_value)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id) DO UPDATE
       SET key_id = EXCLUDED.key_id,
           check_nonce = EXCLUDED.check_nonce,
           check_value = EXCLUDED.check_value,
           created_at = now()`,
    [businessId, keyId, sealed.nonce, sealed.ciphertext],
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
 */
export async function verifyKeyState(
  key: Buffer,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<KeyStateRow>(
    'SELECT check_nonce, check_value FROM credential_key_state WHERE business_id = $1',
    [businessId],
  );
  const row = rows[0];
  if (!row) return;

  const sealed: Sealed = { ciphertext: row.check_value, nonce: row.check_nonce };
  const opened = decryptSecret(sealed, key, { businessId, ref: KEY_CHECK_REF });
  if (opened === null) {
    throw new MasterKeyError(
      'המפתח שסופק אינו תואם למפתח שהצפין את הסודות של ההתקנה הזו — העלייה מסורבת',
    );
  }
}
