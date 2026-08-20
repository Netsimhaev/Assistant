/**
 * `owner:password` — resets the dashboard owner's password, run by hand on
 * the machine the assistant lives on. The other half of the network-free
 * recovery path started by `owner:create`.
 *
 * A password is never accepted as a command-line argument — see the
 * docblock in `create-owner.ts` for why; the same guard is duplicated here
 * rather than shared, so this file's refusal does not depend on that one
 * staying unchanged.
 *
 * `setPassword` (src/dashboard/auth.ts) already revokes every open session
 * in the same transaction as the password write, so a session opened under
 * the old password does not survive a reset here.
 *
 * This command also re-issues the recovery codes, printed once exactly like
 * `owner:create` does. That is a deliberate choice, not an oversight: a
 * password reset through this path is, by construction, the "I have lost
 * access and need the local recovery route" case, and the account's own
 * `setPassword` already treats a password change as grounds to revoke every
 * derived credential (open sessions) rather than leave any of them valid on
 * the old password's authority. A recovery code is exactly that kind of
 * derived credential — proof that stands in for the password — so leaving
 * the old set live after a reset would silently keep an alternate way in
 * open precisely when the owner had reason to distrust the old one. The
 * cost is that the owner must re-save a new set of eight codes every time
 * they reset their password, even if they still have the old ones safely
 * stored; that is judged cheaper than a stale credential nobody remembers
 * to revoke.
 */
import { config } from '../config.js';
import { setPassword } from '../dashboard/auth.js';
import { issueRecoveryCodes } from '../dashboard/recovery.js';
import { closePool, getPool } from '../db/pool.js';
import { nodePromptIo } from './node-prompt-io.js';
import type { PromptIo } from './prompt-io.js';

const DEFAULT_USERNAME = 'owner';

export async function run(argv: string[], io: PromptIo): Promise<number> {
  // See create-owner.ts for the full reasoning; the guard is repeated here
  // on purpose (see file docblock).
  if (argv.some((a) => a.startsWith('--password'))) {
    io.error(
      'סיסמה אינה מתקבלת כפרמטר — היא נשמרת בהיסטוריית הפקודות וגלויה לתהליכים אחרים. הרץ שוב בלי הדגל.',
    );
    return 2;
  }

  const username = argv[0] ?? DEFAULT_USERNAME;
  const businessId = config.businessId;

  // setPassword's UPDATE matches zero rows and returns normally if the
  // account does not exist — it has no way to report "no such account" on
  // its own. Checked here so a typo'd username fails with a clear Hebrew
  // message instead of silently doing nothing.
  const existing = await getPool().query(
    `SELECT 1 FROM dashboard_users WHERE business_id = $1 AND username = $2`,
    [businessId, username],
  );
  if ((existing.rowCount ?? 0) === 0) {
    io.error(`אין חשבון בשם "${username}" עבור עסק זה. הרץ owner:create כדי ליצור אותו.`);
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

  await setPassword({ username, password, businessId });
  const codes = await issueRecoveryCodes({ username, businessId });

  io.print(`הסיסמה עבור "${username}" עודכנה. כל ההתחברויות הפעילות בוטלו.`);
  io.print('');
  io.print('קודי השחזור הישנים בוטלו וקבוצה חדשה הונפקה — מוצגת כאן פעם אחת בלבד ולעולם לא תוצג שוב:');
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
