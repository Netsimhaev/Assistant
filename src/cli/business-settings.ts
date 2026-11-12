/**
 * Write one business's runtime settings (spec §5.10):
 *
 *   npm run business:settings -- --business <id> [--notify-to <addr>]
 *     [--smtp-host <h>] [--smtp-port <n>] [--smtp-secure on|off]
 *     [--smtp-from <addr>] [--smtp-user <u>] [--smtp-allow-cleartext on|off]
 *     [--mail-system <name>] [--whatsapp on|off] [--inbox on|off]
 *     [--cap <name>=<n>|default]...
 *
 * So a second business can stand up before the panel exists. With no flag
 * beyond `--business` it changes nothing and prints the row as it stands.
 * `--<text flag> ''` clears a value; `--cap name=default` returns a cap to the
 * server's default (NULL).
 *
 * The row it prints holds no secret — the table has none. The SMTP password
 * is stored separately, with `npm run secret put NOTIFY_SMTP_PASS …`.
 */
import type { BusinessDb } from '../db/pool.js';
import {
  CAP_COLUMNS,
  CAP_NAMES,
  capFor,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '../tenancy/runtime-settings.js';
import type { CapName, RuntimeSettings, RuntimeSettingsPatch } from '../tenancy/runtime-settings.js';
import { closeCliPools, runForBusiness } from './business-arg.js';

export interface BusinessSettingsCliDeps {
  log: (line: string) => void;
}

type TextField = 'notifyTo' | 'notifySmtpHost' | 'notifySmtpFrom' | 'notifySmtpUser' | 'mailSystem';
type SwitchField = 'notifySmtpSecure' | 'notifySmtpAllowCleartext' | 'whatsappEnabled' | 'inboxEnabled';

const TEXT_FLAGS: Readonly<Record<string, TextField>> = {
  '--notify-to': 'notifyTo',
  '--smtp-host': 'notifySmtpHost',
  '--smtp-from': 'notifySmtpFrom',
  '--smtp-user': 'notifySmtpUser',
  '--mail-system': 'mailSystem',
};

const SWITCH_FLAGS: Readonly<Record<string, SwitchField>> = {
  '--smtp-secure': 'notifySmtpSecure',
  '--smtp-allow-cleartext': 'notifySmtpAllowCleartext',
  '--whatsapp': 'whatsappEnabled',
  '--inbox': 'inboxEnabled',
};

function usage(): string {
  return (
    'שימוש: npm run business:settings -- --business <מזהה> [--notify-to <כתובת>] [--smtp-host <שרת>] ' +
    '[--smtp-port <פורט>] [--smtp-secure on|off] [--smtp-from <כתובת>] [--smtp-user <משתמש>] ' +
    '[--smtp-allow-cleartext on|off] [--mail-system <שם>] [--whatsapp on|off] [--inbox on|off] ' +
    `[--cap <שם>=<מספר>|default]\nתקרות: ${CAP_NAMES.map((name) => CAP_COLUMNS[name]).join(', ')}`
  );
}

function onOff(flag: string, value: string): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error(`הערך של ${flag} חייב להיות on או off (התקבל: ${value})`);
}

/** A cap by its `config` name or by its column (env var in snake case). */
function capName(raw: string): CapName {
  for (const name of CAP_NAMES) {
    if (raw === name || raw === CAP_COLUMNS[name]) return name;
  }
  throw new Error(`תקרה לא מוכרת: ${raw}\n${usage()}`);
}

function wholeNumber(flag: string, raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`הערך של ${flag} חייב להיות מספר שלם אי-שלילי (התקבל: ${raw})`);
  return Number(raw);
}

/** `--flag value` and `--flag=value`. Pure; throws a Hebrew usage error. */
export function parseSettingsArgs(argv: readonly string[]): RuntimeSettingsPatch {
  const patch: RuntimeSettingsPatch = {};
  const caps: Partial<Record<CapName, number | null>> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    let flag = arg;
    let value: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      flag = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    } else {
      value = argv[i + 1];
      // A next token that is itself a flag is a missing value, never the value.
      if (value !== undefined && value.startsWith('--')) value = undefined;
      i += 1;
    }
    if (value === undefined) throw new Error(`חסר ערך ל-${flag}\n${usage()}`);

    const text = TEXT_FLAGS[flag];
    const onoff = SWITCH_FLAGS[flag];
    if (text !== undefined) {
      patch[text] = value;
    } else if (onoff !== undefined) {
      patch[onoff] = onOff(flag, value);
    } else if (flag === '--smtp-port') {
      patch.notifySmtpPort = value === '' ? null : wholeNumber(flag, value);
    } else if (flag === '--cap') {
      const sep = value.indexOf('=');
      if (sep <= 0) throw new Error(`--cap מקבל <שם>=<מספר> או <שם>=default (התקבל: ${value})`);
      const name = capName(value.slice(0, sep));
      const amount = value.slice(sep + 1);
      caps[name] = amount === 'default' ? null : wholeNumber(`--cap ${name}`, amount);
    } else {
      throw new Error(`דגל לא מוכר: ${flag}\n${usage()}`);
    }
  }
  if (Object.keys(caps).length > 0) patch.caps = caps;
  return patch;
}

function shown(value: string | number | boolean | null): string {
  if (value === null) return '(לא מוגדר)';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

/** The row as it stands — every field, never a secret (the table holds none). */
export function renderSettings(businessId: string, settings: RuntimeSettings): string[] {
  const lines = [
    `הגדרות העסק ${businessId}:`,
    `  notify_to                    ${shown(settings.notifyTo)}`,
    `  notify_smtp_host             ${shown(settings.notifySmtpHost)}`,
    `  notify_smtp_port             ${shown(settings.notifySmtpPort)}`,
    `  notify_smtp_secure           ${shown(settings.notifySmtpSecure)}`,
    `  notify_smtp_from             ${shown(settings.notifySmtpFrom)}`,
    `  notify_smtp_user             ${shown(settings.notifySmtpUser)}`,
    `  notify_smtp_allow_cleartext  ${shown(settings.notifySmtpAllowCleartext)}`,
    `  mail_system                  ${shown(settings.mailSystem)}`,
    `  whatsapp_enabled             ${shown(settings.whatsappEnabled)}`,
    `  inbox_enabled                ${shown(settings.inboxEnabled)}`,
    '  תקרות יומיות:',
  ];
  for (const name of CAP_NAMES) {
    const own = settings.caps[name];
    const effective = capFor(settings, name);
    lines.push(`    ${CAP_COLUMNS[name].padEnd(34)} ${own === null ? `${effective} (ברירת המחדל של השרת)` : String(own)}`);
  }
  return lines;
}

export async function runBusinessSettingsCli(
  db: BusinessDb,
  argv: string[],
  deps: BusinessSettingsCliDeps,
): Promise<void> {
  const patch = parseSettingsArgs(argv);
  const settings = Object.keys(patch).length === 0 ? await loadRuntimeSettings(db) : await saveRuntimeSettings(db, patch);
  for (const line of renderSettings(db.businessId, settings)) deps.log(line);
}

export async function main(
  argv: string[],
  io: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  try {
    return await runForBusiness(argv, io.error, (db, rest) => runBusinessSettingsCli(db, rest, { log: io.log }));
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
