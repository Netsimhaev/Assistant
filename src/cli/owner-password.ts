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
 * `setPassword` (src/dashboard/auth.ts) revokes every open session and
 * every trusted device in the same transaction as the password write, so
 * neither a session opened nor a device trusted under the old password
 * survives a reset here. The second factor itself is left as it is.
 */
import { setPassword } from '../dashboard/auth.js';
import { withBusiness } from '../db/pool.js';
import { BUSINESS_ARG_EXIT_CODE, closeCliPools, resolveBusinessArg } from './business-arg.js';
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

  // `--business` before the first prompt and before any read: a refusal
  // here must leave nothing behind and ask for nothing (`business-arg.ts`).
  const business = await resolveBusinessArg(argv);
  if (!business.ok) {
    io.error(business.message);
    return BUSINESS_ARG_EXIT_CODE;
  }
  const { businessId } = business;
  const username = business.rest[0] ?? DEFAULT_USERNAME;

  // setPassword's UPDATE matches zero rows and returns normally if the
  // account does not exist — it has no way to report "no such account" on
  // its own. Checked here so a typo'd username fails with a clear Hebrew
  // message instead of silently doing nothing.
  const existing = await withBusiness(businessId, (db) => db.query(
    `SELECT 1 FROM dashboard_users WHERE business_id = $1 AND username = $2`,
    [businessId, username],
  ));
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

  await withBusiness(businessId, (db) => setPassword(db, { username, password }));

  io.print(`הסיסמה עבור "${username}" עודכנה. כל ההתחברויות הפעילות וכל המכשירים המהימנים בוטלו.`);

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
