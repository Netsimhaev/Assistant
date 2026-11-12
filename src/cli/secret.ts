/**
 * `secret` — the platform operator's tool for putting a credential into an
 * installation, and the ONLY way one ever gets there: the customer never
 * touches it directly (spec §6). Four commands: `put`, `list`, `remove`,
 * `test`.
 *
 * **The secret is read from standard input, never from an argument.** An
 * argument lands in the shell's history file and in the machine's process
 * list, so the secret would leak at the exact moment of securing it — the
 * same reasoning `create-owner.ts` and `owner-password.ts` already apply to
 * a dashboard password. `put`'s legitimate shape is exactly three argv
 * elements (`put`, `<ref>`, `<operator>`); a fourth is refused outright
 * rather than silently ignored, and nothing is written when it is.
 *
 * **There is no command that prints a secret.** `test` reports whether a ref
 * resolves; it never reveals what it resolves to. This was put to the
 * project owner as their decision with the cost stated plainly — there is
 * then no way to verify a stored value against its source from inside the
 * system — and they chose it. No command below ever reads `handle.value`.
 *
 * **The audit distinguishes three cases, and the distinction is the
 * point.** A secret resolved during a job step (`run-plan.ts`) writes no
 * audit row at all — the step is already audited, and a second row per
 * resolve would bury the signal. A resolve that failed there is likewise
 * unaudited on its own (`credential_unavailable` is the step's own outcome).
 * Neither of those is this file's concern. What IS this file's concern:
 * every action of THIS tool — put, list, remove, test — is audited always,
 * naming the business, the ref and the operator, never the value. A `test`
 * that fails to resolve is the interesting event here (a misspelled ref, or
 * someone probing), so it is audited exactly like a `test` that succeeds —
 * the outcome differs, the fact that a row is written does not.
 *
 * The business is a required `--business <id>` flag, checked before
 * anything is read or written (`business-arg.ts`) — one server holds many
 * businesses, and a secret filed under the wrong one is a secret handed to the
 * wrong customer. The flag is removed from argv before the commands below see
 * it, so the "fourth argument" refusal stays unambiguous: `--business` is
 * never mistaken for a value, and a fourth positional still is.
 */
import { appendAudit } from '../audit/log.js';
import type { BusinessDb } from '../db/pool.js';
import {
  listSecretRefs,
  putSecret,
  removeSecret,
  storedCredentials,
} from '../governance/credential-store.js';
import { loadMasterKey } from '../governance/master-key.js';
import { canonicalHash } from '../util/canonical.js';
import {
  listPlatformSecrets,
  putPlatformSecret,
  removePlatformSecret,
  resolvePlatformSecret,
} from '../tenancy/platform-credentials.js';
import { closeCliPools, runForBusiness } from './business-arg.js';
import { nodePromptIo } from './node-prompt-io.js';

export interface SecretCliDeps {
  log: (line: string) => void;
  /** Reads the secret's value. Never given a prompt string or an argv slot. */
  readSecret: () => Promise<string>;
}

const COMMANDS = ['put', 'list', 'remove', 'test'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value);
}

function usage(): string {
  return `שימוש:\n` +
    `  secret put <הפניה> <מפעיל> --business <מזהה>     — קורא את הסוד מהקלט הסטנדרטי\n` +
    `  secret list <מפעיל> --business <מזהה>\n` +
    `  secret remove <הפניה> <מפעיל> --business <מזהה>\n` +
    `  secret test <הפניה> <מפעיל> --business <מזהה>    — בודק שההפניה נפתרת, בלי לחשוף את הערך\n` +
    `פקודות חוקיות: ${COMMANDS.join(', ')}`;
}

/**
 * The master key, read fresh from `CREDENTIAL_KEY_PATH` for every command
 * that needs it (`put`, `test`). No default path and no "carry on without a
 * key" branch — the same refusal `buildRuntime` (`orchestrator/runtime.ts`)
 * already applies to the scheduler.
 */
async function loadKeyFromEnv(): Promise<Buffer> {
  const path = process.env['CREDENTIAL_KEY_PATH'];
  if (path === undefined || path.length === 0) {
    throw new Error(
      'CREDENTIAL_KEY_PATH אינו מוגדר — אין מפתח לפתוח בו את הסודות',
    );
  }
  return loadMasterKey(path);
}

/**
 * Write one `credential_change` row. Called for every command that actually
 * ran, success or failure alike — `reason` is the only free-text field, and
 * it is built by every call site below from the business, the ref and the
 * operator only. Never from anything that could hold a secret's value.
 */
export async function auditAction(db: BusinessDb, params: {
  ref: string | null;
  operator: string;
  action: Command;
  reason: string;
}): Promise<void> {
  await appendAudit(
    db,
    {
      actor: 'human',
      onBehalfOf: params.operator,
      kind: 'credential_change',
      // Not tied to any charter decision — this tool sits beside the gate,
      // not behind it (spec §6.1) — so there is no version to name, the
      // same convention `erasure.ts` and `autonomy-mode.ts` already use for
      // an owner action that is not a policy evaluation.
      charterVersion: 'n/a',
      provenance: 'boss',
      inputHash: canonicalHash({
        action: params.action,
        businessId: db.businessId,
        ref: params.ref,
        operator: params.operator,
      }),
      reason: params.reason,
    }
  );
}

export async function runSecretCli(db: BusinessDb, argv: string[], deps: SecretCliDeps): Promise<void> {
  const { log } = deps;
  const businessId = db.businessId;
  const command = argv[0];

  if (!isCommand(command)) {
    throw new Error(`פקודה לא מוכרת: "${command ?? ''}"\n\n${usage()}`);
  }

  if (command === 'put') {
    const ref = argv[1];
    const operator = argv[2];
    if (ref === undefined || operator === undefined) {
      throw new Error(usage());
    }
    // Spec §6.2 — see the file docblock. A legitimate `put` carries exactly
    // three argv elements; a fourth can only be an attempt to pass the
    // secret itself on the command line. Refused before anything is read
    // from stdin or written anywhere, and the message never echoes argv.
    if (argv.length > 3) {
      throw new Error(
        'הסוד אינו מתקבל כארגומנט בשורת הפקודה — הוא נקרא מהקלט הסטנדרטי (stdin) בלבד, ' +
          'ולא נכתב דבר',
      );
    }

    const key = await loadKeyFromEnv();
    const value = await deps.readSecret();
    await putSecret(db, { ref, value, updatedBy: operator }, key);
    await auditAction(db, {
      ref,
      operator,
      action: 'put',
      reason: `סוד "${ref}" נכתב עבור ${businessId} על ידי ${operator}`,
    });
    log(`הסוד "${ref}" נשמר עבור ${businessId}.`);
    return;
  }

  if (command === 'list') {
    const operator = argv[1];
    if (operator === undefined) {
      throw new Error(usage());
    }

    const items = await listSecretRefs(db);
    await auditAction(db, {
      ref: null,
      operator,
      action: 'list',
      reason: `רשימת הסודות (${items.length} הפניות) עבור ${businessId} נצפתה על ידי ${operator}`,
    });

    if (items.length === 0) {
      log(`אין סודות שמורים עבור ${businessId}.`);
    }
    for (const item of items) {
      log(
        `${item.ref}\tkey=${item.keyId}\tעודכן=${item.updatedAt.toISOString()}\tעל ידי=${item.updatedBy}`,
      );
    }
    return;
  }

  if (command === 'remove') {
    const ref = argv[1];
    const operator = argv[2];
    if (ref === undefined || operator === undefined) {
      throw new Error(usage());
    }

    const removed = await removeSecret(db, ref);
    await auditAction(db, {
      ref,
      operator,
      action: 'remove',
      reason: removed
        ? `סוד "${ref}" הוסר עבור ${businessId} על ידי ${operator}`
        : `הסרת סוד "${ref}" עבור ${businessId} על ידי ${operator} — לא היה סוד כזה`,
    });
    log(removed ? `הסוד "${ref}" הוסר.` : `לא נמצא סוד בשם "${ref}" עבור ${businessId}.`);
    return;
  }

  // command === 'test'
  const ref = argv[1];
  const operator = argv[2];
  if (ref === undefined || operator === undefined) {
    throw new Error(usage());
  }

  const key = await loadKeyFromEnv();
  const handle = await storedCredentials(key).resolve(ref, businessId);
  const resolved = handle !== null;
  await auditAction(db, {
    ref,
    operator,
    action: 'test',
    reason: resolved
      ? `בדיקת סוד "${ref}" עבור ${businessId} על ידי ${operator} — נפתר בהצלחה`
      : `בדיקת סוד "${ref}" עבור ${businessId} על ידי ${operator} — לא נפתר`,
  });
  log(resolved ? `הסוד "${ref}" נפתר בהצלחה.` : `הסוד "${ref}" אינו נפתר.`);
}

/** The flag that targets the server's own secrets instead of a business's. */
const PLATFORM_FLAG = '--platform';

const PLATFORM_COMMANDS = ['put', 'list', 'remove', 'test'] as const;
type PlatformCommand = (typeof PLATFORM_COMMANDS)[number];

export interface PlatformSecretCliDeps extends SecretCliDeps {
  /** stderr: the one trace line each action leaves. */
  error: (line: string) => void;
}

/**
 * `secret --platform put|list|remove|test` — the SERVER's secrets
 * (`platform_credentials`): the Google and Microsoft OAuth client id/secret,
 * which belong to the application and to no business (spec §5.4). No
 * `--business`: there is no business to name. The same stdin-only rule as
 * `put` above, and the same "no command prints a value" rule as `test`.
 *
 * **No audit-chain row, and what stands in for one.** `audit_log` is a chain
 * per business, and a platform secret has no business whose chain it belongs
 * in. Instead `put` stores the required `<operator>` on the row itself
 * (`updated_by`, migration 065), `list` shows it, `put`/`remove` both demand
 * the installation's verified master key, and every action writes one line to
 * stderr naming the operator, the action and the ref — never the value.
 */
export async function runPlatformSecretCli(argv: string[], deps: PlatformSecretCliDeps): Promise<void> {
  const { log } = deps;
  const command = argv[0];
  const platformUsage =
    `שימוש:\n` +
    `  secret --platform put <הפניה> <מפעיל>     — קורא את הסוד מהקלט הסטנדרטי\n` +
    `  secret --platform list <מפעיל>\n` +
    `  secret --platform test <הפניה> <מפעיל>\n` +
    `  secret --platform remove <הפניה> <מפעיל>`;
  if (command === undefined || !(PLATFORM_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(platformUsage);
  }
  const action = command as PlatformCommand;
  const operator = action === 'list' ? argv[1] : argv[2];
  if (operator === undefined) throw new Error(platformUsage);
  const trace = (ref: string | null): void => {
    deps.error(`secret --platform ${action}${ref === null ? '' : ` ${ref}`} — מפעיל: ${operator}`);
  };

  if (action === 'list') {
    if (argv.length !== 2) throw new Error(platformUsage);
    const items = await listPlatformSecrets();
    trace(null);
    if (items.length === 0) log('אין סודות שמורים במאגר השרת.');
    for (const item of items) {
      log(`${item.ref}\tעודכן=${item.updatedAt.toISOString()}\tעל ידי=${item.updatedBy}`);
    }
    return;
  }

  const ref = argv[1];
  if (ref === undefined) throw new Error(platformUsage);
  if (argv.length > 3) {
    // Same refusal as the business `put`: a fourth element can only be the
    // secret itself on the command line, and the message never echoes it.
    throw new Error(
      'הסוד אינו מתקבל כארגומנט בשורת הפקודה — הוא נקרא מהקלט הסטנדרטי (stdin) בלבד, ' +
        'ולא נכתב דבר',
    );
  }
  const key = await loadKeyFromEnv();
  if (action === 'put') {
    const value = await deps.readSecret();
    await putPlatformSecret(ref, value, key, operator);
    trace(ref);
    log(`הסוד "${ref}" נשמר במאגר השרת.`);
    return;
  }
  if (action === 'remove') {
    const removed = await removePlatformSecret(ref, key);
    trace(ref);
    log(removed ? `הסוד "${ref}" הוסר ממאגר השרת.` : `לא נמצא סוד בשם "${ref}" במאגר השרת.`);
    return;
  }
  const resolved = (await resolvePlatformSecret(ref, key)) !== null;
  trace(ref);
  log(resolved ? `הסוד "${ref}" נפתר בהצלחה.` : `הסוד "${ref}" אינו נפתר.`);
}

/**
 * The process entry: `--business` first (exit code 2, nothing read from stdin
 * and nothing written on a refusal, `business-arg.ts`), then the command on
 * one connection for that business. Returns the exit code so a test can drive
 * it without a process.
 */
export async function main(
  argv: string[],
  io: { log: (line: string) => void; error: (line: string) => void; readSecret: () => Promise<string> },
): Promise<number> {
  try {
    if (argv.includes(PLATFORM_FLAG)) {
      if (argv.some((arg) => arg === '--business' || arg.startsWith('--business='))) {
        io.error('--platform ו---business אינם הולכים יחד — סוד של השרת אינו שייך לאף עסק');
        return 2;
      }
      await runPlatformSecretCli(
        argv.filter((arg) => arg !== PLATFORM_FLAG),
        { log: io.log, error: io.error, readSecret: io.readSecret },
      );
      return 0;
    }
    return await runForBusiness(argv, io.error, (db, rest) =>
      runSecretCli(db, rest, { log: io.log, readSecret: io.readSecret }));
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// Only run when executed directly — never on import from the test. Same
// pattern as src/cli/set-ramp.ts and src/cli/seed-job.ts.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntrypoint) {
  process.exitCode = await main(process.argv.slice(2), {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    // No prompt text — the argument shape `SecretCliDeps` declares takes
    // none, and the real terminal prompt lives in `node-prompt-io.ts`.
    readSecret: () => nodePromptIo.readSecret('סוד: '),
  });
  await closeCliPools();
}
