/**
 * `secret:key` — creates, rotates and restores the platform's master key
 * (spec §5, §6.1). Three commands: `create`, `rotate`, `restore`. There is
 * no fourth that reveals the key, on purpose — see `create` below.
 *
 * **Survivability has three layers for three different failures (spec §5),
 * and this file is where two of them live.** A wrong or damaged key file is
 * caught at startup by `verifyKeyState` (`master-key.ts`) — this file does
 * not repeat that check, it relies on it. A LOST key file is recovered here,
 * from a passphrase-protected copy (`restore`). A key file that is lost
 * AND whose passphrase is forgotten is recovered from nothing — the
 * one-time printout `create` shows below is the last net, and if that is
 * gone too the secrets are gone. There is no fourth path. Pretending
 * otherwise — a "just in case" way to reprint or re-derive the key — would
 * be the dishonest kind of design this project has already rejected once
 * for the secret's own value (spec §6.3: no `show` command either).
 *
 * **The passphrase is derived with `scrypt`, matching `src/dashboard/auth.ts`
 * exactly** — same primitive, same call shape (`scrypt(password, salt,
 * keylen)`), a fresh random salt per recovery copy. Not re-exported from
 * there because that module's `scrypt` is private to it; this is the same
 * mechanism declared a second time, not a second mechanism.
 *
 * **The recovery copy seals the key with the very cipher it protects**
 * (`encryptSecret`/`decryptSecret`, T1) under a fixed AAD ref, `key-recovery`
 * — lowercase and hyphenated, exactly like `master-key.ts`'s own
 * `key-check`, and for the same reason: `CREDENTIAL_REF_PATTERN` is
 * `/^[A-Z0-9_]+$/`, so a real credential ref can never collide with it. Two
 * disjoint-by-construction AAD domains beside the real credentials, not one
 * fewer.
 */
import { randomBytes, randomUUID, scrypt as scryptCb } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { appendAudit } from '../audit/log.js';
import { acquireAdvisoryLock, closePool, type Queryable, type BusinessDb } from '../db/pool.js';
import { ROTATION_LOCK_SCOPE } from '../governance/credential-store.js';
import {
  KEY_BYTES,
  loadMasterKey,
  verifyKeyState,
  writeKeyState,
} from '../governance/master-key.js';
import { grantAad } from '../governance/oauth-grants.js';
import { closePlatformPool, withPlatform } from '../db/platform-pool.js';
import { platformAad } from '../tenancy/platform-credentials.js';
import { decryptSecret, encryptSecret } from '../governance/secret-cipher.js';
import { canonicalHash } from '../util/canonical.js';
import { nodePromptIo } from './node-prompt-io.js';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

/**
 * The AAD ref the recovery copy is sealed under. Not a real credential ref —
 * it never touches the `credentials` table — but structurally disjoint from
 * one for the same reason `master-key.ts`'s `key-check` is: a real ref must
 * match `/^[A-Z0-9_]+$/`, so this lowercase, hyphenated spelling can never
 * collide with it. Do not "tidy" this to uppercase.
 */
const RECOVERY_AAD_REF = 'key-recovery';

/**
 * The business half of the recovery copy's authenticated data. The key is the
 * server's (spec §5.9), so a copy sealed from now on names no business: `''`,
 * a value no business id (`^[a-z0-9-]{3,63}$`) can take — the same choice
 * `master-key.ts` makes for the key check.
 *
 * A copy sealed before the key moved to the server was sealed under the
 * business the installation was configured for. That copy belongs to the key
 * whose check row migration 067 carried over, and that row names the same
 * business in `check_business_id` — so `restore` opens a copy under the
 * business the server's key state names, and finds the old copies too.
 */
const SERVER_RECOVERY_BUSINESS = '';

/**
 * What a rotation did, carried on `RotationAuditUnrecordedError` so an
 * operator can reconstruct the record by hand.
 *
 * Deliberately only identifiers and counts. **Never the key and never a
 * secret** — the same rule every message in this file and in `secret.ts`
 * follows, and an error object is no more exempt from it than a log line is.
 * `previousKeyId` is `string | null` because a rotation on an installation
 * whose key-state row was somehow absent has no earlier id to name, and
 * inventing one would be worse than admitting it.
 *
 * `secretsReEncrypted` and `grantsReEncrypted` are two counts, not one merged
 * total — the same reason the printed summary keeps them apart: an operator
 * reconstructing this row by hand needs to know how many `credentials` rows
 * and how many `oauth_grants` rows moved, because they are two different
 * tables with two different re-encryption loops, and "14 rows" does not say
 * which loop stalled if only one of them actually ran.
 */
export interface RotationOutcome {
  /**
   * The registered businesses whose trails the record was written for —
   * `null` when the audit failed before that list was known, which is the
   * usual case: the list is what `auditKeyAction` returns once every row is
   * written, so a failure in the middle never got it.
   */
  businesses: readonly string[] | null;
  previousKeyId: string | null;
  newKeyId: string;
  secretsReEncrypted: number;
  grantsReEncrypted: number;
  /** The server's own secrets (`platform_credentials`), re-sealed in the same transaction. */
  platformSecretsReEncrypted: number;
}

/**
 * The rotation committed and its audit entry did not.
 *
 * Same shape and same reason as `KillSwitchAuditUnrecordedError`
 * (`src/governance/killswitch.ts`) and `ErasureAuditUnrecordedError`
 * (`src/governance/erasure.ts`): once the irreversible half of an action has
 * already committed, the only honest failure left is "it happened, and the
 * record of it is missing" — never "it didn't happen" and never silence.
 * Without it the operator sees a raw database error after every secret has
 * been re-encrypted, cannot tell whether the rotation took effect, and may
 * run it a second time.
 *
 * `rotationInForce` is `true as const` for the same reason the other two
 * carry their flag: the fact the caller most needs is not in the error's
 * type name.
 *
 * **The message is Hebrew, unlike the two precedents', on purpose.** Both of
 * those surface through the dashboard, which re-renders them; this one is
 * printed straight to an operator's terminal by `main()` below, so it follows
 * the rule every other throw in this file follows (`עברית לבני אדם`). It also
 * carries every field of `outcome` inline rather than only on the object,
 * because `main()`'s handler prints `err.message` and nothing else — an
 * operator must be able to reconstruct the missing row from what reaches the
 * screen, without a debugger.
 */
export class RotationAuditUnrecordedError extends Error {
  readonly rotationInForce = true as const;
  readonly outcome: RotationOutcome;

  constructor(outcome: RotationOutcome, cause: unknown) {
    super(
      `החלפת המפתח בוצעה במלואה ורשומת הביקורת עליה נכשלה. ההחלפה בתוקף: ` +
        `${outcome.secretsReEncrypted} סודות, ${outcome.grantsReEncrypted} הרשאות ו-` +
        `${outcome.platformSecretsReEncrypted} סודות שרת הוצפנו ` +
        `מחדש בשרת (העסקים: ${outcome.businesses === null ? '(לא ידוע)' : outcome.businesses.length === 0 ? 'אין' : outcome.businesses.join(', ')}), ` +
        `מהמפתח ${outcome.previousKeyId ?? '(לא ידוע)'} אל המפתח ${outcome.newKeyId}, ` +
        `וקובץ המפתח ועותק השחזור כבר נכתבו — אל תריץ rotate שוב. מה שחסר הוא רק ` +
        `הרישום, ויש להשלים אותו ידנית.`,
      { cause },
    );
    this.name = 'RotationAuditUnrecordedError';
    this.outcome = outcome;
  }
}

export interface SecretKeyCliDeps {
  log: (line: string) => void;
  /**
   * Reads the passphrase that protects the recovery copy. Never given an
   * argv slot — the same rule `SecretCliDeps.readSecret` follows in
   * `secret.ts`, and for the same reason: a test must never need a terminal,
   * and an argument would land in shell history.
   *
   * It *is* given the prompt to show, unlike `readSecret`, because
   * `readNewPassphrase` calls it twice in a row and an operator facing the
   * same sentence twice cannot tell a confirmation from a rejected attempt.
   * A test injects a zero-argument function and ignores it.
   */
  readPassphrase: (prompt: string) => Promise<string>;
  /** Where the live key file lives. Injected rather than read from an env
   * var here, so a test never touches `process.env`. */
  keyPath: string;
}

const COMMANDS = ['create', 'rotate', 'restore'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value);
}

function usage(): string {
  return (
    `שימוש:\n` +
    `  secret-key create <מפעיל>   — יוצר מפתח חדש; מסרב אם כבר קיים אחד\n` +
    `  secret-key rotate <מפעיל>   — מחליף את המפתח ומצפין מחדש כל סוד\n` +
    `  secret-key restore <מפעיל> — משחזר את קובץ המפתח מעותק השחזור\n` +
    `פקודות חוקיות: ${COMMANDS.join(', ')}`
  );
}

function recoveryPathFor(keyPath: string): string {
  return `${keyPath}.recovery`;
}

interface RecoveryFile {
  /** hex */
  salt: string;
  /** hex */
  nonce: string;
  /** hex */
  ciphertext: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether this server already has an active key, independent of
 * whether the file at `keyPath` happens to exist. A file can be moved or
 * deleted without the database forgetting it ever sealed anything — `create`
 * must refuse on either signal, not just the one a mistyped path would hide. */
async function keyStateExists(db: Queryable): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM server_key_state');
  return rows.length > 0;
}

/**
 * The business the server's key state was sealed for: `''` for every row the
 * server writes, the old configured business for a row migration 067 carried
 * over (see `SERVER_RECOVERY_BUSINESS`). `''` when there is no row at all.
 */
async function keyStateBusiness(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ check_business_id: string }>(
    'SELECT check_business_id FROM server_key_state',
  );
  return rows[0]?.check_business_id ?? SERVER_RECOVERY_BUSINESS;
}

async function sealRecoveryCopy(key: Buffer, passphrase: string): Promise<RecoveryFile> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(passphrase, salt, KEY_BYTES);
  const sealed = encryptSecret(key.toString('base64'), derived, {
    businessId: SERVER_RECOVERY_BUSINESS,
    ref: RECOVERY_AAD_REF,
  });
  return {
    salt,
    nonce: sealed.nonce.toString('hex'),
    ciphertext: sealed.ciphertext.toString('hex'),
  };
}

/**
 * Opens the recovery copy, or throws. A wrong passphrase and a corrupted
 * file are not distinguished — the caller's only correct response to either
 * is the same refusal, and `decryptSecret` already collapses every open
 * failure into `null` for exactly this reason.
 */
async function openRecoveryCopy(
  file: RecoveryFile,
  passphrase: string,
  businessId: string,
): Promise<Buffer> {
  const derived = await scrypt(passphrase, file.salt, KEY_BYTES);
  const opened = decryptSecret(
    { ciphertext: Buffer.from(file.ciphertext, 'hex'), nonce: Buffer.from(file.nonce, 'hex') },
    derived,
    { businessId, ref: RECOVERY_AAD_REF },
  );
  if (opened === null) {
    throw new Error(
      'הסיסמה שגויה, או שעותק השחזור פגום — לא ניתן לשחזר את המפתח ממנו',
    );
  }
  const key = Buffer.from(opened, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`עותק השחזור פגום: אורך המפתח שהוחזר שגוי (${key.length} בתים)`);
  }
  return key;
}

/**
 * One transaction on the platform pool — `withBusinessTransaction`'s shape, on
 * the login that reaches every business's rows and the server's own table.
 */
async function withPlatformTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return withPlatform(async (tx) => {
    await tx.query('BEGIN');
    try {
      const result = await fn(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => {
        // A broken connection; the original error is the one worth reporting.
      });
      throw error;
    }
  });
}

/** Every registered business, in byte order — whose trails a key action is recorded in. */
async function registeredBusinesses(tx: Queryable): Promise<string[]> {
  const { rows } = await tx.query<{ business_id: string }>(
    'SELECT business_id FROM businesses ORDER BY business_id COLLATE "C"',
  );
  return rows.map((row) => row.business_id);
}

/**
 * Record a key action in the audit trail of EVERY registered business, on the
 * caller's platform transaction.
 *
 * The key is the server's (spec §5.9), so a key action has no one owning
 * business — but it is not nobody's business either: every business's
 * secrets are sealed under that key, and a rotation re-seals every one of
 * them. So each business's own chain carries the row, rather than none
 * (the ruling for a platform SECRET, which no business's data depends on, is
 * a trace on the row and a stderr line instead — R12). A server with no
 * registered business yet records no row; the stderr line below is then the
 * whole trace.
 *
 * `appendAudit` takes a `BusinessDb`; here it is a view of the platform
 * transaction naming one registered business at a time — the platform login
 * is the one that may write any business's rows, and every row joins `tx`, so
 * "the key exists" and "the key was recorded" commit together. Returns the
 * businesses recorded.
 */
async function auditKeyAction(
  tx: Queryable,
  params: { operator: string; action: Command; reason: string },
): Promise<string[]> {
  // The operator's own trace, beside the rows — and the whole trace on a
  // server with no business yet. Printed FIRST, before any row is written, so
  // it is there on the failure path too: an audit that throws halfway still
  // leaves the line saying who did what. Never the key, never a secret.
  console.error(`secret-key ${params.action} — מפעיל: ${params.operator}`);
  const businesses = await registeredBusinesses(tx);
  for (const businessId of businesses) {
    const view: BusinessDb = { businessId, inTransaction: true, query: tx.query.bind(tx) as Queryable['query'] };
    await appendAudit(view, {
      actor: 'human',
      onBehalfOf: params.operator,
      kind: 'credential_change',
      // Key management is an owner action beside the gate, not a charter
      // decision — the same convention `secret.ts` already uses.
      charterVersion: 'n/a',
      provenance: 'boss',
      inputHash: canonicalHash({
        action: params.action,
        businessId,
        operator: params.operator,
      }),
      reason: params.reason,
    });
  }
  return businesses;
}

/**
 * The floor a NEW recovery passphrase must clear.
 *
 * Sixteen, where `src/dashboard/server.ts`'s `MIN_PASSWORD_LENGTH` is ten,
 * and the gap between them is the whole argument. That one guards a login
 * that answers on a loopback socket, counts its failures and locks the
 * account after five — an attacker gets a handful of guesses and then
 * nothing. This one guards a file whose documented purpose is to be copied
 * somewhere else, `.env.example` and `create`'s own output included; whoever
 * holds a copy guesses against it offline, as fast as their hardware allows,
 * with nothing counting and nothing to lock. The weaker secret got the floor
 * and the stronger one got none.
 *
 * This is not hardening for its own sake. The permission to store the copy
 * beside a database backup is granted on the claim that the copy is worth
 * nothing without its passphrase — so the passphrase is precisely the thing
 * that must not be left to an operator in a hurry.
 */
const MIN_PASSPHRASE_CHARS = 16;

/**
 * Reads a NEW passphrase — the one `create` and `rotate` choose for the
 * recovery copy they are about to seal. Read twice and compared, because of
 * the property this file's header states: there is no fourth recovery path.
 * A mistyped passphrase does not fail here. It fails months later, on the
 * one day the copy is needed, and by then there is nothing to be done —
 * a typo silently converts the backup layer into an empty file. The second
 * read costs an operator a few seconds, once.
 *
 * **`restore` deliberately does not come through here**, and the two checks
 * are the reason: it *enters* an existing passphrase rather than choosing
 * one. A floor there would refuse a copy that was legitimately sealed before
 * this floor existed — locking an operator out of the very layer this file
 * exists to protect — and a retype there proves nothing that opening the
 * copy does not already prove.
 */
async function readNewPassphrase(deps: SecretKeyCliDeps): Promise<string> {
  const passphrase = await deps.readPassphrase('סיסמה לעותק השחזור: ');
  if (passphrase.length === 0) {
    throw new Error('סיסמה ריקה אינה מתקבלת עבור עותק השחזור.');
  }
  if (passphrase.length < MIN_PASSPHRASE_CHARS) {
    throw new Error(
      `הסיסמה קצרה מדי — נדרשים לפחות ${MIN_PASSPHRASE_CHARS} תווים לעותק השחזור, ` +
        `ולא נכתב דבר. העותק הזה מיועד להישמר גם מחוץ לשרת, ומי שמחזיק אותו יכול ` +
        `לנחש עליו סיסמאות בלי הגבלה ובלי שאיש ידע — האורך הוא כל מה שעומד מולו.`,
    );
  }
  const again = await deps.readPassphrase('הקלד שוב את אותה סיסמה: ');
  if (again !== passphrase) {
    throw new Error(
      'שתי ההקלדות אינן זהות, ולא נכתב דבר. סיסמה שהוקלדה בטעות מתגלה רק ביום שבו ' +
        'צריך לשחזר ממנה — ואז אין דרך רביעית.',
    );
  }
  return passphrase;
}

/**
 * Spec §5.3 — shown once, here, and nowhere else. `rotate` mints a brand
 * new key and `restore` recovers an old one, but neither ever calls `log`
 * with the raw bytes: the recovery copy (§5.2) is the durable backup for
 * both, not a second printout.
 */
async function create(deps: SecretKeyCliDeps, operator: string): Promise<void> {
  // **Input first, before anything is written anywhere.** The passphrase is
  // pure input and costs nothing to collect early — and collecting it late
  // cost two of the three survivability layers. Read after the key file and
  // the key state were already written, an empty line, an EOF or a Ctrl-D
  // (all reachable from `nodePromptIo.readSecret`) threw *between* the live
  // key and its backup: the installation kept a key file and a key-state row
  // with no recovery copy, no one-time printout and no audit row, and a
  // second `create` was then refused by both guards below — leaving the
  // operator holding a key that exists in exactly one place, pointed at a
  // `restore` that cannot work because there is nothing to restore from.
  // Measured on this branch, not reasoned about. Sealing the copy is done
  // here too, for the same reason: `scrypt` can fail, and a failure here
  // must land before the first write, not between two of them.
  const passphrase = await readNewPassphrase(deps);

  const key = randomBytes(KEY_BYTES);
  const keyId = `KEY-${randomUUID()}`;
  const recovery = await sealRecoveryCopy(key, passphrase);

  // One transaction, holding `ROTATION_LOCK_SCOPE` — the identical lock
  // `putSecret` and `rotate` take. `pathExists`/`keyStateExists` are
  // check-then-write, so without it two simultaneous creates could each pass
  // both guards and leave the key file from one beside the key state of the
  // other: an installation that refuses to start, with the file and the row
  // naming different keys. One operator runs this tool, which is why this was
  // a low finding and not a high one, but check-then-write under a lock that
  // already exists costs nothing.
  //
  // On the PLATFORM pool: `server_key_state` is the server's, not any
  // business's, and the audit rows below go into every registered business's
  // trail — the platform login is the one that may write them all, in this
  // one transaction.
  await withPlatformTransaction(async (tx: Queryable) => {
    await acquireAdvisoryLock(tx, ROTATION_LOCK_SCOPE);

    // Refuse, do not prompt (task requirement). Checked BEFORE any write:
    // overwriting a key file orphans every stored secret irreversibly, and a
    // tool that does it on a mistyped path is a tool that will eventually do
    // it. Two independent signals, because either alone can be missing while
    // the other is real: the file can be deleted without the database
    // forgetting it sealed something, and a fresh machine can be pointed at
    // an existing database before any file has ever been written to it.
    if (await pathExists(deps.keyPath)) {
      throw new Error(
        `כבר קיים קובץ מפתח בנתיב "${deps.keyPath}" — יצירה הייתה דורסת אותו ומייתמת ` +
          `לצמיתות כל סוד שכבר נשמר תחתיו. אם התכוונת להחליף מפתח, הרץ rotate. אם התכוונת ` +
          `לשחזר קובץ שאבד, הרץ restore.`,
      );
    }
    if (await keyStateExists(tx)) {
      throw new Error(
        `לשרת כבר יש מפתח פעיל רשום בבסיס הנתונים, גם אם הקובץ ` +
          `בנתיב "${deps.keyPath}" חסר — יצירת מפתח חדש הייתה מייתמת כל סוד שכבר נשמר. ` +
          `הרץ restore אם הכוונה היא לשחזר קובץ שאבד.`,
      );
    }

    await writeKeyState(key, keyId, tx);

    // Inside the transaction, so "a key exists" and "a key was recorded"
    // commit together — spec §6.4 says every tool action is audited ALWAYS,
    // and an audit row written last is a row any throw above it skips. Cheap
    // here: `create` holds the audit lock for two statements, not for a whole
    // re-encryption pass (contrast `rotate` below).
    await auditKeyAction(tx, {
      operator,
      action: 'create',
      reason: `מפתח חדש לשרת (${keyId}) נוצר על ידי ${operator}`,
    });

    // The two file writes come last, still inside the lock. They are not
    // transactional with the database — the same physical boundary
    // `erasure.ts` documents — so the ordering picks which failure is
    // survivable: a throw here rolls the database back, leaving NO key state,
    // so the operator deletes whatever landed on disk and runs `create`
    // again. Nothing was sealed under this key yet, so nothing is lost. The
    // reverse (key state committed, files missing) would be the stuck state
    // above, with neither `create` nor `restore` able to proceed. The
    // recovery copy is written before the live key for the same reason: of
    // the two, the backup is the one whose absence is silent.
    await writeFile(recoveryPathFor(deps.keyPath), JSON.stringify(recovery), { mode: 0o600 });
    await writeFile(deps.keyPath, key, { mode: 0o600 });
  });

  deps.log('המפתח נוצר בהצלחה. השורה הבאה מציגה אותו פעם אחת בלבד — הוא לא יוצג שוב לעולם:');
  deps.log(key.toString('base64'));
  deps.log(
    'שמור אותו עכשיו במקום בטוח ונפרד מגיבוי בסיס הנתונים. עותק שחזור מוגן בסיסמה נכתב ' +
      `לצדו (${recoveryPathFor(deps.keyPath)}). מותר לגבות אותו גם מחוץ לשרת — אבל רק ` +
      'משום שהסיסמה אינה כתובה באף מקום: היא הדבר היחיד שעומד בין מי שמחזיק את העותק ' +
      'לבין כל הסודות של כל הלקוחות, והוא יכול לנחש עליה בלי הגבלה ובלי שנדע. שמור אותה ' +
      'במקום שהגיבוי אינו מגיע אליו. אם גם הקובץ, גם עותק השחזור וגם הסיסמה אבדו — ' +
      'הסודות אבודים לצמיתות. אין דרך רביעית.',
  );
}

async function restore(deps: SecretKeyCliDeps, operator: string): Promise<void> {
  if (await pathExists(deps.keyPath)) {
    throw new Error(
      `כבר קיים קובץ מפתח בנתיב "${deps.keyPath}" — שחזור לתוכו היה עלול לדרוס מפתח ` +
        `תקין. הזז או מחק אותו קודם, רק אם ברור שהוא פגום.`,
    );
  }

  const recoveryPath = recoveryPathFor(deps.keyPath);
  let raw: string;
  try {
    raw = await readFile(recoveryPath, 'utf8');
  } catch (error) {
    throw new Error(`לא ניתן לקרוא את עותק השחזור (${recoveryPath})`, { cause: error });
  }
  const file = JSON.parse(raw) as RecoveryFile;

  // Read once, with no floor and no retype — the opposite of
  // `readNewPassphrase`, and deliberately so: this passphrase is being
  // *entered*, not chosen. A floor here would refuse a copy sealed before
  // that floor existed, and a retype would prove nothing that opening the
  // copy does not already prove. The one check worth making is the empty
  // line, because an EOF or a Ctrl-D otherwise arrives as "wrong passphrase
  // or corrupted copy" and sends the operator hunting for a damaged file.
  const passphrase = await deps.readPassphrase('סיסמה של עותק השחזור: ');
  if (passphrase.length === 0) {
    throw new Error('לא הוקלדה סיסמה — עותק השחזור לא נפתח, ושום דבר לא נכתב.');
  }
  // On the platform pool: the key state is the server's row. Read-only up to
  // the file write, so the copy is opened and checked before anything is written.
  await withPlatformTransaction(async (tx: Queryable) => {
    const key = await openRecoveryCopy(file, passphrase, await keyStateBusiness(tx));

    // Belt and braces: confirm this is genuinely the key this server's
    // rows were sealed with before it is written back as the live key. A
    // recovery copy could in principle be stale (kept from a key that was
    // later rotated away) — `verifyKeyState` is the same check `buildRuntime`
    // runs at startup, run here before anything touches disk.
    await verifyKeyState(key, tx);

    await writeFile(deps.keyPath, key, { mode: 0o600 });

    await auditKeyAction(tx, {
      operator,
      action: 'restore',
      reason: `מפתח השרת שוחזר מעותק השחזור על ידי ${operator}`,
    });
  });

  deps.log('המפתח שוחזר בהצלחה מעותק השחזור.');
}

interface CredentialRow {
  business_id: string;
  ref: string;
  ciphertext: Buffer;
  nonce: Buffer;
}

interface GrantRow {
  business_id: string;
  system: string;
  ciphertext: Buffer;
  nonce: Buffer;
}

interface PlatformSecretRow {
  ref: string;
  ciphertext: Buffer;
  nonce: Buffer;
}

/**
 * Spec §4.5 — re-encrypts every stored secret under a brand new key and
 * leaves none behind. A partial rotation is worse than none: some rows
 * would open only with the old key, some only with the new, and no single
 * key would open the installation.
 *
 * Every row of every business — the server has exactly one live key, and
 * every business's secrets are sealed under it (spec §5.9) — is re-encrypted
 * **in one transaction**: a
 * failure partway rolls the database back to exactly what it was before
 * rotation started, rather than leaving a mix. The same transaction takes
 * `ROTATION_LOCK_SCOPE`, the identical advisory lock `putSecret`
 * (`credential-store.ts`) takes — a lock held on only one side is not a
 * lock, and this is the side Task 4's review named as rotation's to close.
 *
 * **`oauth_grants` is re-encrypted in the same transaction, right after
 * `credentials`.** A key rotation that only knew about `credentials` would
 * leave every stored grant sealed under a key the installation no longer
 * holds — silently, since nothing throws until the next refresh reads a row
 * that no longer opens. That is the same defect class erasure was burned by
 * twice (`job_plans`, `job_authorizations` — a new content-bearing table
 * that is not wired to the thing that must reach every row). The grant loop
 * follows the credentials loop's shape exactly, keyed by `(business_id,
 * system)` instead of `(business_id, ref)`, and aborts the whole rotation
 * the same way on a row that fails to decrypt — no row changes if any one
 * of them can't be opened with the key on file today.
 *
 * **`platform_credentials` — the server's own OAuth client secrets — is the
 * third table, in the same transaction.** Missing it would orphan exactly the
 * secrets every Google and Microsoft refresh needs, the same silent class as
 * the grants above. The whole transaction runs on the PLATFORM pool: that
 * table has no business, and the platform login is the one that reaches every
 * business's rows once row level security is on, so all three loops share one
 * connection and one all-or-nothing commit.
 */
async function rotate(deps: SecretKeyCliDeps, operator: string): Promise<void> {
  const oldKey = await loadMasterKey(deps.keyPath);
  await withPlatform((db) => verifyKeyState(oldKey, db));

  const newKey = randomBytes(KEY_BYTES);
  const newKeyId = `KEY-${randomUUID()}`;

  // **Read and seal before the transaction opens, for the same reason
  // `create` does.** Collected after the commit, an empty passphrase left a
  // rotation that had already succeeded — every row re-encrypted under
  // `newKey`, the key file replaced — beside a recovery copy still holding
  // the RETIRED key. Nothing is corrupted (a `restore` from that copy is
  // correctly refused by `verifyKeyState`), which is exactly what makes it
  // dangerous: the recovery layer is dead while the operator believes it is
  // live, and `rotate` prints nothing, so the new key exists in one place
  // only. Measured on this branch. Both reads above are read-only, so the
  // prompt still comes after the command has established there is a key to
  // rotate at all — this is before the first WRITE, which is the property
  // that matters.
  const passphrase = await readNewPassphrase(deps);
  const recovery = await sealRecoveryCopy(newKey, passphrase);

  const { rotated, grantsRotated, platformRotated, previousKeyId } = await withPlatformTransaction(async (tx: Queryable) => {
    await acquireAdvisoryLock(tx, ROTATION_LOCK_SCOPE);

    // Read BEFORE `writeKeyState` overwrites it. The id of the key being
    // retired is half of what an operator needs to reconstruct the audit row
    // by hand if the append below fails, and after the upsert it is gone.
    const { rows: stateRows } = await tx.query<{ key_id: string }>(
      'SELECT key_id FROM server_key_state',
    );
    const previous = stateRows[0]?.key_id ?? null;

    const { rows } = await tx.query<CredentialRow>(
      'SELECT business_id, ref, ciphertext, nonce FROM credentials FOR UPDATE',
    );

    for (const row of rows) {
      const plain = decryptSecret({ ciphertext: row.ciphertext, nonce: row.nonce }, oldKey, {
        businessId: row.business_id,
        ref: row.ref,
      });
      if (plain === null) {
        throw new Error(
          `החלפת המפתח בוטלה: השורה (${row.business_id}, ${row.ref}) אינה נפתחת ` +
            'במפתח הנוכחי — שום שורה לא שונתה.',
        );
      }
      const sealed = encryptSecret(plain, newKey, { businessId: row.business_id, ref: row.ref });
      await tx.query(
        `UPDATE credentials SET ciphertext = $1, nonce = $2, key_id = $3, updated_at = now()
           WHERE business_id = $4 AND ref = $5`,
        [sealed.ciphertext, sealed.nonce, newKeyId, row.business_id, row.ref],
      );
    }

    // The same loop for grants. A new table that is not wired here means a key
    // rotation silently kills every connection: the row stays sealed under the
    // old key while `server_key_state` says otherwise, and nothing throws
    // until the next refresh. This is the defect class erasure was burned by
    // twice, and `connector-invariants.test.ts` is what keeps it closed.
    const { rows: grantRows } = await tx.query<GrantRow>(
      'SELECT business_id, system, ciphertext, nonce FROM oauth_grants FOR UPDATE',
    );

    for (const row of grantRows) {
      const plain = decryptSecret(
        { ciphertext: row.ciphertext, nonce: row.nonce },
        oldKey,
        grantAad(row.business_id, row.system),
      );
      if (plain === null) {
        throw new Error(
          `החלפת המפתח בוטלה: הרשאת ה-OAuth (${row.business_id}, ${row.system}) אינה ` +
            'נפתחת במפתח הנוכחי — שום שורה לא שונתה.',
        );
      }
      const sealed = encryptSecret(plain, newKey, grantAad(row.business_id, row.system));
      await tx.query(
        `UPDATE oauth_grants SET ciphertext = $1, nonce = $2, key_id = $3
           WHERE business_id = $4 AND system = $5`,
        [sealed.ciphertext, sealed.nonce, newKeyId, row.business_id, row.system],
      );
    }

    // The third loop: the server's own secrets. Same shape, same refusal.
    const { rows: platformRows } = await tx.query<PlatformSecretRow>(
      'SELECT ref, ciphertext, nonce FROM platform_credentials FOR UPDATE',
    );

    for (const row of platformRows) {
      const plain = decryptSecret({ ciphertext: row.ciphertext, nonce: row.nonce }, oldKey, platformAad(row.ref));
      if (plain === null) {
        throw new Error(
          `החלפת המפתח בוטלה: סוד השרת ${row.ref} אינו נפתח במפתח הנוכחי — שום שורה לא שונתה.`,
        );
      }
      const sealed = encryptSecret(plain, newKey, platformAad(row.ref));
      await tx.query(
        `UPDATE platform_credentials SET ciphertext = $1, nonce = $2, key_id = $3, updated_at = now()
           WHERE ref = $4`,
        [sealed.ciphertext, sealed.nonce, newKeyId, row.ref],
      );
    }

    await writeKeyState(newKey, newKeyId, tx);
    return {
      rotated: rows.length,
      grantsRotated: grantRows.length,
      platformRotated: platformRows.length,
      previousKeyId: previous,
    };
  });

  // The database is committed and atomic by this point: every row now opens
  // only under `newKey`, or (on a throw above) none of them changed at all.
  // What follows cannot itself be transactional with the database — the same
  // physical boundary `erasure.ts` documents for its own file/database
  // split. Database first means a failure THERE leaves nothing changed; a
  // failure in the two writes below leaves a key that is already correct in
  // the database but not yet durable on disk anywhere, discoverable at the
  // next startup as `verifyKeyState`'s refusal rather than as silent
  // corruption of a customer's send.
  //
  // Recovery copy before the live key file, so the window in which the backup
  // on disk is the retired key is as short as the code can make it — and both
  // before the audit append, which is the reverse of `create`'s order and
  // deliberate. Once the transaction above has committed, every row opens
  // ONLY under `newKey`, so putting that key on disk is what makes the
  // installation work again; an audit failure that jumped the queue and threw
  // before these two lines would leave a correct database beside a key file
  // holding the retired key — a dead installation, reported by an error whose
  // sentence says only that a record is missing. `create` has no such
  // constraint (nothing is sealed under its key yet), which is why its audit
  // row can sit inside the transaction and this one cannot.
  await writeFile(recoveryPathFor(deps.keyPath), JSON.stringify(recovery), { mode: 0o600 });
  await writeFile(deps.keyPath, newKey, { mode: 0o600 });

  // Last, and outside the transaction on purpose: `appendAudit` takes the
  // `audit:<business>` advisory lock, and holding that for the length of a
  // whole re-encryption pass would block every other audit writer in the
  // installation for as long as rotation runs.
  //
  // Which leaves the boundary `killswitch.ts` and `erasure.ts` already named:
  // by this line the rotation is irreversibly in force, so a failed append
  // has exactly one honest report — "it happened, and the record is missing"
  // — never a raw database error the operator reads as "it failed", and never
  // silence. An operator who reads this as failure runs `rotate` again, which
  // rotates a second time on top of a rotation nobody recorded.
  let businesses: readonly string[] | null = null;
  try {
    // Assigned only once the transaction has COMMITTED: a list taken before
    // the commit would name trails that a failed commit left without the row.
    businesses = await withPlatformTransaction((tx: Queryable) =>
      auditKeyAction(tx, {
        operator,
        action: 'rotate',
        // No counts: this row is written into EVERY business's chain, and the
        // counts are server-wide (other businesses' secrets). They stay on
        // stderr/the log line and in the error outcome (ruling R18).
        reason: `מפתח השרת הוחלף (${newKeyId}) על ידי ${operator}`,
      }),
    );
  } catch (error) {
    throw new RotationAuditUnrecordedError(
      {
        businesses,
        previousKeyId,
        newKeyId,
        secretsReEncrypted: rotated,
        grantsReEncrypted: grantsRotated,
        platformSecretsReEncrypted: platformRotated,
      },
      error,
    );
  }

  deps.log(
    `המפתח הוחלף בהצלחה. ${rotated} סודות, ${grantsRotated} הרשאות ו-${platformRotated} סודות שרת ` +
      'הוצפנו מחדש תחת המפתח החדש.',
  );
}

export async function runSecretKeyCli(argv: string[], deps: SecretKeyCliDeps): Promise<void> {
  const command = argv[0];
  if (!isCommand(command)) {
    throw new Error(`פקודה לא מוכרת: "${command ?? ''}"\n\n${usage()}`);
  }

  const operator = argv[1];
  if (operator === undefined || argv.length > 2) {
    throw new Error(usage());
  }

  if (command === 'create') {
    await create(deps, operator);
    return;
  }
  if (command === 'rotate') {
    await rotate(deps, operator);
    return;
  }
  await restore(deps, operator);
}

async function main(): Promise<void> {
  const keyPath = process.env['CREDENTIAL_KEY_PATH'];
  if (keyPath === undefined || keyPath.length === 0) {
    throw new Error('CREDENTIAL_KEY_PATH אינו מוגדר — אין נתיב לכתוב אליו את קובץ המפתח');
  }
  await runSecretKeyCli(process.argv.slice(2), {
    log: (line) => console.log(line),
    readPassphrase: (prompt) => nodePromptIo.readSecret(prompt),
    keyPath,
  });
}

// Only run when executed directly — never on import from the test. Same
// pattern as src/cli/secret.ts.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntrypoint) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
  await closePlatformPool();
  await closePool();
}
