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
 */
import { DatabaseError } from 'pg';
import { config } from '../config.js';
import { createOwner } from '../dashboard/auth.js';
import { issueRecoveryCodes } from '../dashboard/recovery.js';
import { closePool } from '../db/pool.js';
import { nodePromptIo } from './node-prompt-io.js';
import type { PromptIo } from './prompt-io.js';

const DEFAULT_USERNAME = 'owner';

/** Postgres' unique/primary-key-violation error code. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return err instanceof DatabaseError && err.code === UNIQUE_VIOLATION;
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

  const username = argv[0] ?? DEFAULT_USERNAME;
  const businessId = config.businessId;

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
    await createOwner({ username, password, businessId });
  } catch (err) {
    // Stage 0 allows exactly one row per (business, username) — the
    // composite primary key on dashboard_users enforces it. Catching the
    // constraint violation here, rather than pre-checking with a SELECT and
    // then inserting, avoids a second round trip and a TOCTOU gap between
    // the check and the insert; the account already existing is the one
    // failure mode worth a dedicated Hebrew message instead of a raw
    // Postgres error.
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
  const codes = await issueRecoveryCodes({ username, businessId });

  io.print(`החשבון "${username}" נוצר בהצלחה.`);
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
  await closePool();
  process.exit(code);
}
