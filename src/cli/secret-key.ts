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
import { config } from '../config.js';
import { acquireAdvisoryLock, closePool, getPool, withTransaction } from '../db/pool.js';
import type { Queryable } from '../db/pool.js';
import { ROTATION_LOCK_SCOPE } from '../governance/credential-store.js';
import {
  KEY_BYTES,
  loadMasterKey,
  verifyKeyState,
  writeKeyState,
} from '../governance/master-key.js';
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

export interface SecretKeyCliDeps {
  log: (line: string) => void;
  /**
   * Reads the passphrase that protects the recovery copy. Never given a
   * prompt string or an argv slot — the same rule `SecretCliDeps.readSecret`
   * follows in `secret.ts`, and for the same reason: a test must never need
   * a terminal, and an argument would land in shell history.
   */
  readPassphrase: () => Promise<string>;
  /** Where the live key file lives. Injected rather than read from an env
   * var here, so a test never touches `process.env`. */
  keyPath: string;
  businessId?: string;
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

/** Whether this installation already has an active key, independent of
 * whether the file at `keyPath` happens to exist. A file can be moved or
 * deleted without the database forgetting it ever sealed anything — `create`
 * must refuse on either signal, not just the one a mistyped path would hide. */
async function keyStateExists(businessId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    'SELECT 1 FROM credential_key_state WHERE business_id = $1',
    [businessId],
  );
  return rows.length > 0;
}

async function sealRecoveryCopy(
  key: Buffer,
  passphrase: string,
  businessId: string,
): Promise<RecoveryFile> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(passphrase, salt, KEY_BYTES);
  const sealed = encryptSecret(key.toString('base64'), derived, {
    businessId,
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

async function auditKeyAction(params: {
  businessId: string;
  operator: string;
  action: Command;
  reason: string;
}): Promise<void> {
  await appendAudit(
    {
      actor: 'human',
      onBehalfOf: params.operator,
      kind: 'credential_change',
      // Key management is an owner action beside the gate, not a charter
      // decision — the same convention `secret.ts` already uses.
      charterVersion: 'n/a',
      provenance: 'boss',
      inputHash: canonicalHash({
        action: params.action,
        businessId: params.businessId,
        operator: params.operator,
      }),
      reason: params.reason,
    },
    { businessId: params.businessId },
  );
}

async function readNonEmptyPassphrase(deps: SecretKeyCliDeps): Promise<string> {
  const passphrase = await deps.readPassphrase();
  if (passphrase.length === 0) {
    throw new Error('סיסמה ריקה אינה מתקבלת עבור עותק השחזור.');
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
  const businessId = deps.businessId ?? config.businessId;

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
  if (await keyStateExists(businessId)) {
    throw new Error(
      `להתקנה של "${businessId}" כבר יש מפתח פעיל רשום בבסיס הנתונים, גם אם הקובץ ` +
        `בנתיב "${deps.keyPath}" חסר — יצירת מפתח חדש הייתה מייתמת כל סוד שכבר נשמר. ` +
        `הרץ restore אם הכוונה היא לשחזר קובץ שאבד.`,
    );
  }

  const key = randomBytes(KEY_BYTES);
  const keyId = `KEY-${randomUUID()}`;

  await writeFile(deps.keyPath, key, { mode: 0o600 });
  await writeKeyState(key, keyId, { businessId });

  const passphrase = await readNonEmptyPassphrase(deps);
  const recovery = await sealRecoveryCopy(key, passphrase, businessId);
  await writeFile(recoveryPathFor(deps.keyPath), JSON.stringify(recovery), { mode: 0o600 });

  await auditKeyAction({
    businessId,
    operator,
    action: 'create',
    reason: `מפתח חדש (${keyId}) נוצר עבור ${businessId} על ידי ${operator}`,
  });

  deps.log('המפתח נוצר בהצלחה. השורה הבאה מציגה אותו פעם אחת בלבד — הוא לא יוצג שוב לעולם:');
  deps.log(key.toString('base64'));
  deps.log(
    'שמור אותו עכשיו במקום בטוח ונפרד מגיבוי בסיס הנתונים. עותק שחזור מוגן בסיסמה נכתב ' +
      `לצדו (${recoveryPathFor(deps.keyPath)}) ואפשר לגבות אותו בכל מקום, כולל ענן — בלי ` +
      'הסיסמה הוא חסר ערך. אם גם הקובץ, גם עותק השחזור וגם הסיסמה אבדו — הסודות אבודים ' +
      'לצמיתות. אין דרך רביעית.',
  );
}

async function restore(deps: SecretKeyCliDeps, operator: string): Promise<void> {
  const businessId = deps.businessId ?? config.businessId;

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

  const passphrase = await deps.readPassphrase();
  const key = await openRecoveryCopy(file, passphrase, businessId);

  // Belt and braces: confirm this is genuinely the key this installation's
  // rows were sealed with before it is written back as the live key. A
  // recovery copy could in principle be stale (kept from a key that was
  // later rotated away) — `verifyKeyState` is the same check `buildRuntime`
  // runs at startup, run here before anything touches disk.
  await verifyKeyState(key, { businessId });

  await writeFile(deps.keyPath, key, { mode: 0o600 });

  await auditKeyAction({
    businessId,
    operator,
    action: 'restore',
    reason: `המפתח שוחזר עבור ${businessId} מעותק השחזור על ידי ${operator}`,
  });

  deps.log('המפתח שוחזר בהצלחה מעותק השחזור.');
}

interface CredentialRow {
  business_id: string;
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
 * All twelve — every business, since one installation has exactly one live
 * key today (spec §2.3) — are re-encrypted **in one transaction**: a
 * failure partway rolls the database back to exactly what it was before
 * rotation started, rather than leaving a mix. The same transaction takes
 * `ROTATION_LOCK_SCOPE`, the identical advisory lock `putSecret`
 * (`credential-store.ts`) takes — a lock held on only one side is not a
 * lock, and this is the side Task 4's review named as rotation's to close.
 */
async function rotate(deps: SecretKeyCliDeps, operator: string): Promise<void> {
  const businessId = deps.businessId ?? config.businessId;

  const oldKey = await loadMasterKey(deps.keyPath);
  await verifyKeyState(oldKey, { businessId });

  const newKey = randomBytes(KEY_BYTES);
  const newKeyId = `KEY-${randomUUID()}`;

  const rotated = await withTransaction(async (tx: Queryable) => {
    await acquireAdvisoryLock(tx, ROTATION_LOCK_SCOPE);

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

    await writeKeyState(newKey, newKeyId, { businessId, db: tx });
    return rows.length;
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
  await writeFile(deps.keyPath, newKey, { mode: 0o600 });

  const passphrase = await readNonEmptyPassphrase(deps);
  const recovery = await sealRecoveryCopy(newKey, passphrase, businessId);
  await writeFile(recoveryPathFor(deps.keyPath), JSON.stringify(recovery), { mode: 0o600 });

  await auditKeyAction({
    businessId,
    operator,
    action: 'rotate',
    reason: `המפתח הוחלף (${newKeyId}) עבור ${businessId} על ידי ${operator} — ${rotated} סודות הוצפנו מחדש`,
  });

  deps.log(`המפתח הוחלף בהצלחה. ${rotated} סודות הוצפנו מחדש תחת המפתח החדש.`);
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
    readPassphrase: () => nodePromptIo.readSecret('סיסמה לעותק השחזור: '),
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
  await closePool();
}
