/**
 * `staff` — the platform staff, from the server's command line.
 *
 *   npm run staff -- create-head --email <address> --name "<name>"
 *
 * Creates the first head of the technicians' team: the one who then invites
 * everyone else from the operator panel. Refused while a head exists — the
 * check runs before any prompt, and `createHeadStaff` re-checks under a lock.
 *
 * The password is never an argument (shell history, the process list); it is
 * prompted for twice, with input suppressed (`PromptIo.readSecret`). No second
 * factor here: it is enrolled at the first panel sign-in.
 *
 * Exit codes: 2 for a usage error, 1 for any other refusal.
 */
import { closeCliPools } from './business-arg.js';
import { nodePromptIo } from './node-prompt-io.js';
import type { PromptIo } from './prompt-io.js';
import { normaliseLogin } from '../tenancy/login.js';
import { createHeadStaff, headExists, StaffError, StaffHeadExistsError } from '../tenancy/staff.js';

export const ENROL_ON_FIRST_PANEL_LOGIN_NOTE = 'בכניסה הראשונה לפאנל תתבקש לחבר את Google Authenticator.';
export const HEAD_EXISTS_MESSAGE = 'כבר קיים ראש צוות — אנשי צוות נוספים מוזמנים מהפאנל.';

const USAGE = 'שימוש:\n  npm run staff -- create-head --email <כתובת> --name "<שם>"';

/** `--flag <value>` or `--flag=<value>`, exactly once; `null` otherwise. */
function takeFlag(argv: readonly string[], flag: string): string | null {
  const found: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === flag) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return null;
      found.push(value);
      i += 1;
    } else if (arg !== undefined && arg.startsWith(`${flag}=`)) {
      found.push(arg.slice(flag.length + 1));
    }
  }
  return found.length === 1 ? (found[0] ?? null) : null;
}

export async function run(argv: string[], io: PromptIo): Promise<number> {
  if (argv.some((a) => a.startsWith('--password'))) {
    io.error('סיסמה אינה מתקבלת כפרמטר — היא נשמרת בהיסטוריית הפקודות וגלויה לתהליכים אחרים. הרץ שוב בלי הדגל.');
    return 2;
  }
  if (argv[0] !== 'create-head') {
    io.error(USAGE);
    return 2;
  }
  const email = takeFlag(argv, '--email');
  const name = takeFlag(argv, '--name');
  if (email === null || name === null || name.trim().length === 0) {
    io.error(USAGE);
    return 2;
  }

  if (await headExists()) {
    io.error(HEAD_EXISTS_MESSAGE);
    return 1;
  }

  const password = await io.readSecret('סיסמה חדשה: ');
  const confirmation = await io.readSecret('אימות סיסמה: ');
  if (password !== confirmation) {
    io.error('הסיסמאות אינן תואמות.');
    return 1;
  }

  try {
    await createHeadStaff({ login: email, displayName: name, password });
  } catch (err) {
    if (err instanceof StaffError) {
      io.error(err instanceof StaffHeadExistsError ? HEAD_EXISTS_MESSAGE : err.message);
      return 1;
    }
    throw err;
  }

  io.print(`ראש הצוות "${name.trim()}" נוצר. הכניסה לפאנל: ${normaliseLogin(email)}`);
  io.print(ENROL_ON_FIRST_PANEL_LOGIN_NOTE);
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
