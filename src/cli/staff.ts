/**
 * `staff` — the platform staff, from the server's command line.
 *
 *   npm run staff -- create-head --email <address> --name "<name>"
 *   npm run staff -- reset-factor --email <address>
 *   npm run staff -- reissue-link --email <address>
 *
 * Creates the first head of the technicians' team: the one who then invites
 * everyone else from the operator panel. Refused while a head exists — the
 * check runs before any prompt, and `createHeadStaff` re-checks under a lock.
 *
 * The password is never an argument (shell history, the process list); it is
 * prompted for twice, with input suppressed (`PromptIo.readSecret`). No second
 * factor here: it is enrolled at the first panel sign-in.
 *
 * **Break-glass (final review I2).** `reset-factor` forgets a live member's
 * Authenticator (they enrol again at the next sign-in) and `reissue-link`
 * prints, once, a fresh one-time link (72 h) that lets them set a new
 * password. They exist for the team whose only head lost a phone or a
 * password — no one in the panel could do either for them. Both are logged in
 * the activity log with no staff id (the server command line, migration 076)
 * and `detail: { via: 'cli' }`. Whoever runs them already holds the server.
 *
 * Exit codes: 2 for a usage error, 1 for any other refusal.
 */
import { closeCliPools } from './business-arg.js';
import { nodePromptIo } from './node-prompt-io.js';
import type { PromptIo } from './prompt-io.js';
import { normaliseLogin } from '../tenancy/login.js';
import { logStaffAction } from '../tenancy/activity-log.js';
import {
  createHeadStaff,
  findLiveStaffByLogin,
  headExists,
  reissueStaffLink,
  staffResetSecondFactor,
  StaffError,
  StaffHeadExistsError,
} from '../tenancy/staff.js';

export const ENROL_ON_FIRST_PANEL_LOGIN_NOTE = 'בכניסה הראשונה לפאנל תתבקש לחבר את Google Authenticator.';
export const HEAD_EXISTS_MESSAGE = 'כבר קיים ראש צוות — אנשי צוות נוספים מוזמנים מהפאנל.';

export const STAFF_NOT_FOUND_CLI = 'אין איש צוות פעיל עם הכתובת הזו.';
export const RESET_FACTOR_DONE = 'ה-Authenticator של איש הצוות אופס — בכניסה הבאה לפאנל יתבקש לחבר אותו מחדש.';
export const REISSUE_LINK_COPY =
  'העבר את הקישור לאיש הצוות. הוא תקף ל-72 שעות ולשימוש אחד, ובו בוחרים סיסמה חדשה. הקישור לא יוצג שוב.';
export const NO_BASE_URL_NOTE = 'ADMIN_BASE_URL אינו מוגדר — הוסף לפני הנתיב את כתובת הפאנל.';

const USAGE =
  'שימוש:\n  npm run staff -- create-head --email <כתובת> --name "<שם>"' +
  '\n  npm run staff -- reset-factor --email <כתובת>' +
  '\n  npm run staff -- reissue-link --email <כתובת>';

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
  if (argv[0] === 'reset-factor' || argv[0] === 'reissue-link') return breakGlass(argv[0], argv, io);
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

/** The panel's origin from `ADMIN_BASE_URL`, or `null` when unset or not an http(s) URL. */
function panelOrigin(): string | null {
  const env = process.env['ADMIN_BASE_URL']?.trim();
  if (env === undefined || env.length === 0) return null;
  try {
    const url = new URL(env);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

async function breakGlass(command: 'reset-factor' | 'reissue-link', argv: readonly string[], io: PromptIo): Promise<number> {
  const email = takeFlag(argv, '--email');
  if (email === null) {
    io.error(USAGE);
    return 2;
  }
  const member = await findLiveStaffByLogin(email);
  if (member === null) {
    io.error(STAFF_NOT_FOUND_CLI);
    return 1;
  }
  if (command === 'reset-factor') {
    await staffResetSecondFactor(member.staffId);
    await logStaffAction({ staffId: null, action: 'totp_reset', businessId: null, detail: { via: 'cli' } });
    io.print(RESET_FACTOR_DONE);
    return 0;
  }
  let token: string;
  try {
    ({ token } = await reissueStaffLink(email));
  } catch (err) {
    if (err instanceof StaffError) {
      io.error(STAFF_NOT_FOUND_CLI);
      return 1;
    }
    throw err;
  }
  await logStaffAction({ staffId: null, action: 'staff_link_reissued', businessId: null, detail: { via: 'cli' } });
  const origin = panelOrigin();
  io.print(REISSUE_LINK_COPY);
  if (origin === null) io.print(NO_BASE_URL_NOTE);
  io.print(`${origin ?? ''}/join/${token}`);
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
