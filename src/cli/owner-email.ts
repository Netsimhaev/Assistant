/**
 * `owner:email` — sets the address a dashboard account logs in with:
 *
 *   npm run owner:email -- --business <id> --username <name> --email <address>
 *
 * Why it exists (R23): migration 066 made the login an email address unique
 * across the server, and backfilled `login = username` for every account that
 * existed before it. The login form's field is `type="email"`, so a browser
 * will not submit `owner` — an account migrated from the one-business install
 * cannot log in until its login is a real address. This command is how it
 * gets one, without hand-written SQL.
 *
 * The same rules as `owner:create`, from the same constants: the address is
 * normalised by `normaliseLogin`, must match `EMAIL_SHAPE`, and is refused
 * with `LOGIN_TAKEN_MESSAGE` when any business already holds it in any case
 * (checked through `resolveLogin` for a clear message; the unique index of
 * migration 066 is what actually holds under a race). It writes the one
 * column through `runForBusiness`, on the business's own connection, under
 * row level security. No secret is read or written; open sessions stay open
 * (a session is not tied to the login string).
 */
import { DatabaseError } from 'pg';
import { appendAudit } from '../audit/log.js';
import { transaction } from '../db/pool.js';
import { EMAIL_SHAPE } from '../governance/typed-recipients.js';
import { canonicalHash } from '../util/canonical.js';
import { normaliseLogin } from '../tenancy/login.js';
import { resolveLogin } from '../tenancy/platform.js';
import { closeCliPools, runForBusiness } from './business-arg.js';
import { BAD_EMAIL_MESSAGE, LOGIN_TAKEN_MESSAGE } from './create-owner.js';

const UNIQUE_VIOLATION = '23505';
const LOGIN_UNIQUE_INDEX = 'dashboard_users_login_unique';

const USAGE = 'שימוש: npm run owner:email -- --business <מזהה> --username <שם משתמש> --email <כתובת>';

/** Exit code of a malformed command line — the same as a bad `--business`. */
const USAGE_EXIT_CODE = 2;

/**
 * Pull `--<name> <value>` (or `--<name>=<value>`) out of `argv`. `null` when
 * it is absent, has no value, or appears twice — two values are a guess.
 */
function takeFlag(argv: readonly string[], name: string): { value: string | null; rest: string[] } {
  const flag = `--${name}`;
  const rest: string[] = [];
  const found: string[] = [];
  let missingValue = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === flag) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        missingValue = true;
      } else {
        found.push(next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      found.push(arg.slice(flag.length + 1));
      continue;
    }
    rest.push(arg);
  }
  return { value: !missingValue && found.length === 1 ? (found[0] ?? null) : null, rest };
}

export async function main(
  argv: string[],
  io: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  return runForBusiness(argv, io.error, async (db, afterBusiness) => {
    const username = takeFlag(afterBusiness, 'username');
    const email = takeFlag(username.rest, 'email');
    if (username.value === null || email.value === null || email.rest.length > 0) {
      io.error(USAGE);
      return USAGE_EXIT_CODE;
    }

    const login = normaliseLogin(email.value);
    if (!EMAIL_SHAPE.test(login)) {
      io.error(BAD_EMAIL_MESSAGE);
      return 1;
    }

    const { rows } = await db.query<{ login: string }>(
      'SELECT login FROM dashboard_users WHERE business_id = $1 AND username = $2',
      [db.businessId, username.value],
    );
    const current = rows[0];
    if (current === undefined) {
      io.error(`אין חשבון בשם "${username.value}" בעסק זה.`);
      return 1;
    }
    if (normaliseLogin(current.login) === login) {
      io.log(`הכניסה של "${username.value}" כבר ${login} — לא שונה דבר.`);
      return 0;
    }
    if ((await resolveLogin(login)) !== null) {
      io.error(LOGIN_TAKEN_MESSAGE);
      return 1;
    }

    try {
      // The change and its audit row are one transaction. The row names the
      // business and the account only — never the address, which is the
      // login and personal data.
      await transaction(db, async (tx) => {
        await tx.query(
          'UPDATE dashboard_users SET login = $3 WHERE business_id = $1 AND username = $2',
          [tx.businessId, username.value, login],
        );
        await appendAudit(tx, {
          actor: 'human',
          onBehalfOf: 'operator',
          kind: 'credential_change',
          charterVersion: 'n/a',
          provenance: 'boss',
          inputHash: canonicalHash({
            action: 'owner_email',
            businessId: tx.businessId,
            username: username.value,
          }),
          reason: `כתובת הכניסה של החשבון ${username.value} בעסק ${tx.businessId} הוחלפה`,
        });
      });
    } catch (err) {
      if (err instanceof DatabaseError && err.code === UNIQUE_VIOLATION && err.constraint === LOGIN_UNIQUE_INDEX) {
        io.error(LOGIN_TAKEN_MESSAGE);
        return 1;
      }
      throw err;
    }
    io.log(`הכניסה של "${username.value}" לדשבורד היא עכשיו ${login}.`);
    return 0;
  });
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntrypoint) {
  const code = await main(process.argv.slice(2), {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
  await closeCliPools();
  process.exit(code);
}
