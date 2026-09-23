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
 * Businesses are per-installation, not a CLI argument: this project runs one
 * deployment per business (`config.businessId`, from `BUSINESS_ID`), so
 * `deps.businessId` exists only to let a caller (a test, chiefly) override
 * that for isolation — the same shape `set-ramp.ts` already uses. There is
 * no positional business argument to keep the "fourth argument" refusal
 * unambiguous.
 */
import { appendAudit } from '../audit/log.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import {
  listSecretRefs,
  putSecret,
  removeSecret,
  storedCredentials,
} from '../governance/credential-store.js';
import { loadMasterKey } from '../governance/master-key.js';
import { canonicalHash } from '../util/canonical.js';
import { nodePromptIo } from './node-prompt-io.js';

export interface SecretCliDeps {
  log: (line: string) => void;
  /** Reads the secret's value. Never given a prompt string or an argv slot. */
  readSecret: () => Promise<string>;
  businessId?: string;
}

const COMMANDS = ['put', 'list', 'remove', 'test'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value);
}

function usage(): string {
  return `שימוש:\n` +
    `  secret put <הפניה> <מפעיל>     — קורא את הסוד מהקלט הסטנדרטי\n` +
    `  secret list <מפעיל>\n` +
    `  secret remove <הפניה> <מפעיל>\n` +
    `  secret test <הפניה> <מפעיל>    — בודק שההפניה נפתרת, בלי לחשוף את הערך\n` +
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
async function auditAction(params: {
  businessId: string;
  ref: string | null;
  operator: string;
  action: Command;
  reason: string;
}): Promise<void> {
  await appendAudit(
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
        businessId: params.businessId,
        ref: params.ref,
        operator: params.operator,
      }),
      reason: params.reason,
    },
    { businessId: params.businessId },
  );
}

export async function runSecretCli(argv: string[], deps: SecretCliDeps): Promise<void> {
  const { log } = deps;
  const businessId = deps.businessId ?? config.businessId;
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
    await putSecret({ businessId, ref, value, updatedBy: operator }, key);
    await auditAction({
      businessId,
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

    const items = await listSecretRefs(businessId);
    await auditAction({
      businessId,
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

    const removed = await removeSecret(ref, businessId);
    await auditAction({
      businessId,
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
  await auditAction({
    businessId,
    ref,
    operator,
    action: 'test',
    reason: resolved
      ? `בדיקת סוד "${ref}" עבור ${businessId} על ידי ${operator} — נפתר בהצלחה`
      : `בדיקת סוד "${ref}" עבור ${businessId} על ידי ${operator} — לא נפתר`,
  });
  log(resolved ? `הסוד "${ref}" נפתר בהצלחה.` : `הסוד "${ref}" אינו נפתר.`);
}

async function main(): Promise<void> {
  await runSecretCli(process.argv.slice(2), {
    log: (line) => console.log(line),
    // No prompt text — the argument shape `SecretCliDeps` declares takes
    // none, and the real terminal prompt lives in `node-prompt-io.ts`.
    readSecret: () => nodePromptIo.readSecret('סוד: '),
  });
}

// Only run when executed directly — never on import from the test. Same
// pattern as src/cli/set-ramp.ts and src/cli/seed-job.ts.
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
