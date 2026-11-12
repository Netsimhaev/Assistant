/**
 * `owner:create` — creates the dashboard owner's account, run by hand on the
 * machine the assistant lives on.
 *
 * A password is never accepted as a command-line argument. An argument lands
 * in shell history (readable long after the session ends) and is visible to
 * every other process on the machine through the process list — a
 * lower-privileged process or a shoulder-surfed `ps`/Task Manager view reads
 * it as easily as the owner typing it. The password is always prompted for,
 * with input suppressed by `PromptIo.readSecret` (see `node-prompt-io.ts`).
 *
 * This is the network-free recovery path: no self-registration, no emailed
 * link, nothing that touches the mailbox the assistant itself reads.
 *
 * `--email <address>` is the login (spec §5.5): one dashboard serves every
 * business, and the address alone decides which business a login opens. It
 * is unique across the server in any case (migration 066), so an address
 * another business already holds is refused before any prompt.
 */
import { DatabaseError } from 'pg';
import { createOwner } from '../dashboard/auth.js';
import { normaliseLogin } from '../tenancy/login.js';
import { issueRecoveryCodes } from '../dashboard/recovery.js';
import { withBusiness } from '../db/pool.js';
import { EMAIL_SHAPE } from '../governance/typed-recipients.js';
import { resolveLogin } from '../tenancy/platform.js';
import { BUSINESS_ARG_EXIT_CODE, closeCliPools, resolveBusinessArg } from './business-arg.js';
import { nodePromptIo } from './node-prompt-io.js';
import type { PromptIo } from './prompt-io.js';

const DEFAULT_USERNAME = 'owner';

/** Postgres' unique/primary-key-violation error code. */
const UNIQUE_VIOLATION = '23505';

/** Migration 066's index: the login is unique across every business. */
const LOGIN_UNIQUE_INDEX = 'dashboard_users_login_unique';

/** Printed when the address is already some business's login, in any case. */
export const LOGIN_TAKEN_MESSAGE = 'הכתובת כבר רשומה';

/** Printed when `--email` is missing or is not an email address. */
export const BAD_EMAIL_MESSAGE = 'כתובת מייל לא תקינה: --email <כתובת>';

function isUniqueViolation(err: unknown): boolean {
  return err instanceof DatabaseError && err.code === UNIQUE_VIOLATION;
}

/**
 * Pull `--email <address>` (or `--email=<address>`) out of `argv`. `null`
 * when it is absent, has no value, or appears twice — two addresses are two
 * logins, and picking one is a guess.
 */
function takeEmailFlag(argv: readonly string[]): { email: string | null; rest: string[] } {
  const rest: string[] = [];
  const found: string[] = [];
  let missingValue = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--email') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        missingValue = true;
      } else {
        found.push(value);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--email=')) {
      found.push(arg.slice('--email='.length));
      continue;
    }
    rest.push(arg);
  }
  const email = !missingValue && found.length === 1 ? (found[0] ?? null) : null;
  return { email, rest };
}

export async function run(argv: string[], io: PromptIo): Promise<number> {
  // See file docblock. Refuse outright rather than accepting it with a
  // warning — a warning still leaves the password sitting in history.
  if (argv.some((a) => a.startsWith('--password'))) {
    io.error(
      'סיסמה אינה מתקבלת כפרמטר — היא נשמרת בהיסטוריית הפקודות וגלויה לתהליכים אחרים. הרץ שוב בלי הדגל.',
    );
    return 2;
  }

  // `--business` before the first prompt and before any read: a refusal
  // here must leave nothing behind and ask for nothing (`business-arg.ts`).
  const business = await resolveBusinessArg(argv);
  if (!business.ok) {
    io.error(business.message);
    return BUSINESS_ARG_EXIT_CODE;
  }
  const { businessId } = business;
  const { email, rest } = takeEmailFlag(business.rest);
  const username = rest[0] ?? DEFAULT_USERNAME;

  // The login before the first prompt too: a refusal asks for nothing.
  const login = email === null ? '' : normaliseLogin(email);
  if (!EMAIL_SHAPE.test(login)) {
    io.error(BAD_EMAIL_MESSAGE);
    return 1;
  }
  // Checked here for a clear message; the unique index below is what
  // actually holds under a concurrent creation.
  if ((await resolveLogin(login)) !== null) {
    io.error(LOGIN_TAKEN_MESSAGE);
    return 1;
  }

  const password = await io.readSecret('סיסמה חדשה: ');
  if (password.length === 0) {
    io.error('סיסמה ריקה אינה מתקבלת.');
    return 1;
  }
  const confirmation = await io.readSecret('אימות סיסמה: ');
  if (password !== confirmation) {
    io.error('הסיסמאות אינן תואמות.');
    return 1;
  }

  try {
    await withBusiness(businessId, (db) => createOwner(db, { username, login, password }));
  } catch (err) {
    // Stage 0 allows exactly one row per (business, username) — the
    // composite primary key on dashboard_users enforces it. Catching the
    // constraint violation here, rather than pre-checking with a SELECT and
    // then inserting, avoids a second round trip and a TOCTOU gap between
    // the check and the insert; the account already existing is the one
    // failure mode worth a dedicated Hebrew message instead of a raw
    // Postgres error.
    if (isUniqueViolation(err) && (err as DatabaseError).constraint === LOGIN_UNIQUE_INDEX) {
      io.error(LOGIN_TAKEN_MESSAGE);
      return 1;
    }
    if (isUniqueViolation(err)) {
      io.error(
        `חשבון בשם "${username}" כבר קיים עבור עסק זה. לאיפוס הסיסמה הרץ owner:password.`,
      );
      return 1;
    }
    throw err;
  }

  // A brand-new account gets a brand-new set of recovery codes in the same
  // run — there is nothing to rotate away from yet, so this is simply
  // "issue the first set", not the same judgement call `owner:password`
  // has to make about an *existing* set.
  const codes = await withBusiness(businessId, (db) => issueRecoveryCodes(db, { username }));

  io.print(`החשבון "${username}" נוצר בהצלחה. הכניסה לדשבורד: ${login}`);
  io.print('');
  io.print('קודי שחזור — מוצגים כאן פעם אחת בלבד ולעולם לא יוצגו שוב:');
  io.print('שמור אותם עכשיו במקום בטוח לפני שאתה ממשיך. הם אינם נשמרים במערכת בצורה שניתן לשחזר.');
  codes.forEach((code, index) => io.print(`  ${index + 1}. ${code}`));

  return 0;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntrypoint) {
  const code = await run(process.argv.slice(2), nodePromptIo);
  await closeCliPools();
  process.exit(code);
}
