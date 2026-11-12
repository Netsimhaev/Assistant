/**
 * Move one install's environment settings into the database (spec §5.4, §5.11):
 *
 *   npm run tenancy:import-env -- --business <id>
 *
 * Three things, all for the one business named:
 *
 *  1. The settings the runtime used to read from the environment
 *     (`APPROVAL_NOTIFY_TO`, `SMTP_*`, `MAIL_SYSTEM`, `DOCUMENT_INBOX` as a
 *     switch, the GREEN-API refs as a switch, and every daily cap) become that
 *     business's `business_runtime_settings` row. A variable that is not set
 *     is not written — the row keeps whatever it had.
 *  2. The secrets the env named by ref (`NOTIFY_CREDENTIAL_REF`,
 *     `GREEN_API_INSTANCE_REF`, `GREEN_API_TOKEN_REF`) are COPIED to the fixed
 *     names the per-business runtime resolves (`NOTIFY_SMTP_PASS`,
 *     `GREEN_API_INSTANCE_ID`, `GREEN_API_TOKEN`). Copied, not moved: the old
 *     ref may also be what a binding points at.
 *  3. The four OAuth client secrets are MOVED from the business's
 *     `credentials` into `platform_credentials` — they belong to the
 *     application, and the runtime now reads them only there. A platform
 *     value that already exists and differs is never overwritten.
 *
 * It prints what it moved and what was missing — names only, never a value.
 */
import type { BusinessDb } from '../db/pool.js';
import { putSecret, removeSecret, resolveStoredSecret } from '../governance/credential-store.js';
import { loadMasterKey, verifyKeyState } from '../governance/master-key.js';
import { GOOGLE_CLIENT_ID_REF, GOOGLE_CLIENT_SECRET_REF } from '../orchestrator/adapters/google-token-http.js';
import {
  MICROSOFT_CLIENT_ID_REF,
  MICROSOFT_CLIENT_SECRET_REF,
} from '../orchestrator/adapters/microsoft-token-http.js';
import { CREDENTIAL_REF_PATTERN } from '../orchestrator/credentials.js';
import { GREEN_API_INSTANCE_ID_REF, GREEN_API_TOKEN_REF, NOTIFY_SMTP_PASS_REF } from '../orchestrator/runtime.js';
import { putPlatformSecret, resolvePlatformSecret } from '../tenancy/platform-credentials.js';
import { CAP_COLUMNS, CAP_NAMES, saveRuntimeSettings } from '../tenancy/runtime-settings.js';
import type { CapName, RuntimeSettingsPatch } from '../tenancy/runtime-settings.js';
import { closeCliPools, runForBusiness } from './business-arg.js';
import { auditAction } from './secret.js';

export const OAUTH_CLIENT_REFS = [
  GOOGLE_CLIENT_ID_REF,
  GOOGLE_CLIENT_SECRET_REF,
  MICROSOFT_CLIENT_ID_REF,
  MICROSOFT_CLIENT_SECRET_REF,
] as const;

/** Each fixed per-business secret, and the env var that named its old ref. */
const RENAMED_SECRETS = [
  ['NOTIFY_CREDENTIAL_REF', NOTIFY_SMTP_PASS_REF],
  ['GREEN_API_INSTANCE_REF', GREEN_API_INSTANCE_ID_REF],
  ['GREEN_API_TOKEN_REF', GREEN_API_TOKEN_REF],
] as const;

/**
 * Who the audit rows name. This command takes no operator argument (the
 * brief's shape is `--business` alone), so it names itself.
 */
export const IMPORT_OPERATOR = 'tenancy:import-env';

/** A cap's environment variable: its column, upper-cased. */
function capEnvName(name: CapName): string {
  return CAP_COLUMNS[name].toUpperCase();
}

type Env = Record<string, string | undefined>;

function present(env: Env, name: string): string | null {
  const value = env[name];
  return value === undefined || value.trim().length === 0 ? null : value.trim();
}

/** The settings patch the environment describes. Pure; refuses a malformed number. */
export function settingsFromEnv(env: Env): RuntimeSettingsPatch {
  const patch: RuntimeSettingsPatch = {};
  const notifyTo = present(env, 'APPROVAL_NOTIFY_TO');
  if (notifyTo !== null) patch.notifyTo = notifyTo;
  const host = present(env, 'SMTP_HOST');
  if (host !== null) patch.notifySmtpHost = host;
  const port = present(env, 'SMTP_PORT');
  if (port !== null) {
    if (!/^\d+$/.test(port)) throw new Error(`SMTP_PORT אינו מספר שלם (התקבל: ${port})`);
    patch.notifySmtpPort = Number(port);
  }
  // Positive checks, the same reading the env-based runtime gave them: a typo
  // can only ever leave the stricter setting in place.
  const secure = present(env, 'SMTP_SECURE');
  if (secure !== null) patch.notifySmtpSecure = secure === 'true';
  const cleartext = present(env, 'SMTP_ALLOW_CLEARTEXT');
  if (cleartext !== null) patch.notifySmtpAllowCleartext = cleartext === '1';
  const from = present(env, 'SMTP_FROM');
  if (from !== null) patch.notifySmtpFrom = from;
  const user = present(env, 'SMTP_USER');
  if (user !== null) patch.notifySmtpUser = user;
  const mailSystem = present(env, 'MAIL_SYSTEM');
  if (mailSystem !== null) patch.mailSystem = mailSystem;

  // The two env switches: the inbox was on when a folder was set, WhatsApp
  // when both GREEN-API refs were.
  if (present(env, 'DOCUMENT_INBOX') !== null) patch.inboxEnabled = true;
  if (present(env, 'GREEN_API_INSTANCE_REF') !== null && present(env, 'GREEN_API_TOKEN_REF') !== null) {
    patch.whatsappEnabled = true;
  }

  const caps: Partial<Record<CapName, number>> = {};
  for (const name of CAP_NAMES) {
    const raw = present(env, capEnvName(name));
    if (raw === null) continue;
    if (!/^\d+$/.test(raw)) throw new Error(`${capEnvName(name)} אינו מספר שלם אי-שלילי (התקבל: ${raw})`);
    caps[name] = Number(raw);
  }
  if (Object.keys(caps).length > 0) patch.caps = caps;
  return patch;
}

export interface ImportEnvReport {
  settings: string[];
  copiedSecrets: string[];
  movedToPlatform: string[];
  missing: string[];
  conflicts: string[];
}

/**
 * Do the three moves for `db`'s business. Returns names only; the caller
 * prints them. No value of any secret leaves this function.
 */
export async function importEnv(db: BusinessDb, env: Env, key: Buffer): Promise<ImportEnvReport> {
  const report: ImportEnvReport = { settings: [], copiedSecrets: [], movedToPlatform: [], missing: [], conflicts: [] };

  const patch = settingsFromEnv(env);
  await saveRuntimeSettings(db, patch);
  for (const field of Object.keys(patch)) {
    if (field === 'caps') {
      for (const name of Object.keys(patch.caps ?? {}) as CapName[]) report.settings.push(CAP_COLUMNS[name]);
    } else {
      report.settings.push(field);
    }
  }

  for (const [envName, fixedRef] of RENAMED_SECRETS) {
    const oldRef = present(env, envName);
    if (oldRef === null) {
      report.missing.push(envName);
      continue;
    }
    if (!CREDENTIAL_REF_PATTERN.test(oldRef)) {
      report.missing.push(`${envName} (הפניה לא חוקית)`);
      continue;
    }
    if (oldRef === fixedRef) {
      // Already stored under the fixed name — nothing to copy.
      const stored = await resolveStoredSecret(db, key, fixedRef);
      (stored === null ? report.missing : report.copiedSecrets).push(fixedRef);
      continue;
    }
    const stored = await resolveStoredSecret(db, key, oldRef);
    if (stored === null) {
      report.missing.push(`${oldRef} (${envName})`);
      continue;
    }
    await putSecret(db, { ref: fixedRef, value: stored.value, updatedBy: IMPORT_OPERATOR }, key);
    // The same `credential_change` row `secret put` writes — names only.
    await auditAction(db, {
      ref: fixedRef,
      operator: IMPORT_OPERATOR,
      action: 'put',
      reason: `סוד "${fixedRef}" נכתב עבור ${db.businessId} (הועתק מ-"${oldRef}") על ידי ${IMPORT_OPERATOR}`,
    });
    report.copiedSecrets.push(`${oldRef} → ${fixedRef}`);
  }

  for (const ref of OAUTH_CLIENT_REFS) {
    const stored = await resolveStoredSecret(db, key, ref);
    if (stored === null) {
      report.missing.push(ref);
      continue;
    }
    const existing = await resolvePlatformSecret(ref, key);
    if (existing !== null && existing !== stored.value) {
      // Another business's import already set the server's value, and this
      // one differs. Which is right is the operator's call, not a guess.
      report.conflicts.push(ref);
      continue;
    }
    if (existing === null) await putPlatformSecret(ref, stored.value, key, IMPORT_OPERATOR);
    await removeSecret(db, ref);
    // The same row `secret remove` writes: the business's store lost a
    // secret, and its own audit chain says so — names only, never the value.
    await auditAction(db, {
      ref,
      operator: IMPORT_OPERATOR,
      action: 'remove',
      reason: `סוד "${ref}" הוסר עבור ${db.businessId} והועבר למאגר השרת על ידי ${IMPORT_OPERATOR}`,
    });
    report.movedToPlatform.push(ref);
  }
  return report;
}

export function renderImportReport(businessId: string, report: ImportEnvReport): string[] {
  const list = (items: string[]): string => (items.length === 0 ? '(אין)' : items.join(', '));
  return [
    `ייבוא הגדרות מהסביבה לעסק ${businessId}:`,
    `  הגדרות שנכתבו: ${list(report.settings)}`,
    `  סודות שהועתקו לשם הקבוע: ${list(report.copiedSecrets)}`,
    `  סודות שהועברו למאגר השרת: ${list(report.movedToPlatform)}`,
    `  חסרים: ${list(report.missing)}`,
    ...(report.conflicts.length > 0
      ? [`  התנגשות — במאגר השרת כבר יש ערך אחר, ולא נדרס (העותק של העסק נשאר): ${list(report.conflicts)}`]
      : []),
  ];
}

export async function main(
  argv: string[],
  io: { log: (line: string) => void; error: (line: string) => void },
  env: Env = process.env,
): Promise<number> {
  try {
    return await runForBusiness(argv, io.error, async (db, rest) => {
      if (rest.length > 0) throw new Error(`ארגומנט לא צפוי: ${rest[0]}\nשימוש: npm run tenancy:import-env -- --business <מזהה>`);
      const path = env['CREDENTIAL_KEY_PATH'];
      if (path === undefined || path.length === 0) {
        throw new Error('CREDENTIAL_KEY_PATH אינו מוגדר — אין מפתח לפתוח בו את הסודות');
      }
      const key = await loadMasterKey(path);
      // A key file that is not the one this installation sealed with would
      // write rows that open for nobody — refused before anything is touched.
      await verifyKeyState(key);
      const report = await importEnv(db, env, key);
      for (const line of renderImportReport(db.businessId, report)) io.log(line);
    });
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// Only run when executed directly — never on import from the test. Same
// pattern as src/cli/set-ramp.ts.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntrypoint) {
  process.exitCode = await main(process.argv.slice(2), {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
  await closeCliPools();
}
