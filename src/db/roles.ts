import { closePool, getMigratorPool, type Queryable } from './pool.js';
import { config } from '../config.js';

export interface RoleLogin {
  user: string;
  password: string;
}

export interface RoleLogins {
  app: RoleLogin;
  platform: RoleLogin;
}

/** The NOLOGIN group every app login belongs to. Owns nothing, NOBYPASSRLS. */
export const APP_GROUP_ROLE = 'assistant_app';

/**
 * The NOLOGIN group that holds the platform login's privileges on the
 * server's own tables (`businesses`, `platform_credentials`,
 * `server_key_state`) — migration 068 revoked those from `assistant_app`,
 * through which the platform login took everything else. The app login must
 * never belong to it.
 */
export const PLATFORM_GROUP_ROLE = 'assistant_platform_group';

/** A plain lowercase Postgres identifier — no quoting games in a role name. */
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function assertRoleName(name: string): void {
  if (!ROLE_NAME.test(name)) {
    throw new Error('role name must match ^[a-z_][a-z0-9_]{0,62}$');
  }
  if (name === APP_GROUP_ROLE || name === PLATFORM_GROUP_ROLE) {
    throw new Error(`a login cannot be the group role ${name} itself`);
  }
}

/**
 * Build one statement server-side with `format(%I, %L)`, so the password is
 * quoted by Postgres and never spliced into SQL by hand.
 */
async function execFormatted(admin: Queryable, template: string, args: string[]): Promise<void> {
  const placeholders = args.map((_, i) => `, $${i + 2}::text`).join('');
  const { rows } = await admin.query<{ sql: string }>(
    `SELECT format($1::text${placeholders}) AS sql`,
    [template, ...args],
  );
  const sql = rows[0]?.sql;
  if (sql === undefined) throw new Error('format() returned no statement');
  await admin.query(sql);
}

async function roleExists(admin: Queryable, name: string): Promise<boolean> {
  const { rows } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  return rows.length > 0;
}

async function currentDatabase(admin: Queryable): Promise<string> {
  const { rows } = await admin.query<{ db: string }>('SELECT current_database() AS db');
  const db = rows[0]?.db;
  if (db === undefined) throw new Error('current_database() returned nothing');
  return db;
}

/** Every login is denied these, on CREATE and on ALTER alike. */
const LOGIN_LIMITS = 'NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION';

async function ensureLogin(
  admin: Queryable,
  login: RoleLogin,
  bypass: 'BYPASSRLS' | 'NOBYPASSRLS',
  mustNotBeMemberOf: readonly string[],
): Promise<void> {
  // Refuse to touch the admin's own role or any superuser. Today's .env puts
  // `postgres` in DATABASE_URL; running `db:roles` before changing it must not
  // demote the cluster's superuser and rewrite its password.
  const { rows } = await admin.query<{ rolsuper: boolean; is_self: boolean; admin_member: boolean }>(
    `SELECT rolsuper,
            rolname = current_user AS is_self,
            pg_has_role(rolname, current_user, 'MEMBER') AS admin_member
       FROM pg_roles WHERE rolname = $1`,
    [login.user],
  );
  const existing = rows[0];
  if (existing?.is_self === true || existing?.rolsuper === true) {
    throw new Error(
      `refusing to turn ${login.user} into an application login: it is a superuser or the admin role itself — set DATABASE_URL / DATABASE_PLATFORM_URL to dedicated logins`,
    );
  }
  // A login that inherits the admin role inherits ownership of every table —
  // the exact privilege the app role must never hold.
  if (existing?.admin_member === true) {
    throw new Error(
      `refusing ${login.user} as an application login: it is a member of the admin role — revoke that membership or use a dedicated login`,
    );
  }
  if (existing !== undefined) {
    for (const other of mustNotBeMemberOf) {
      if (!(await roleExists(admin, other))) continue;
      const { rows: member } = await admin.query<{ m: boolean }>(
        "SELECT pg_has_role($1, $2, 'MEMBER') AS m",
        [login.user, other],
      );
      if (member[0]?.m === true) {
        throw new Error(
          `refusing ${login.user} as the app login: it is a member of ${other}, ${other === PLATFORM_GROUP_ROLE ? "the platform login's group" : 'the BYPASSRLS platform login'} — revoke that membership`,
        );
      }
    }
    await execFormatted(admin, `ALTER ROLE %I LOGIN PASSWORD %L ${bypass} ${LOGIN_LIMITS}`, [
      login.user,
      login.password,
    ]);
    await execFormatted(admin, `GRANT ${APP_GROUP_ROLE} TO %I`, [login.user]);
  } else {
    await execFormatted(
      admin,
      `CREATE ROLE %I LOGIN PASSWORD %L ${bypass} ${LOGIN_LIMITS} IN ROLE ${APP_GROUP_ROLE}`,
      [login.user, login.password],
    );
  }
}

async function ensureRolesOnce(admin: Queryable, logins: RoleLogins): Promise<void> {
  await admin.query('BEGIN');
  try {
    // Roles are cluster-wide, so an advisory lock (per database) serialises
    // only callers on the same database; a concurrent caller on another
    // database is handled by the retry in `ensureRoles`.
    await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('db:ensure-roles', 0))");

    if (!(await roleExists(admin, APP_GROUP_ROLE))) {
      await admin.query(`CREATE ROLE ${APP_GROUP_ROLE} NOLOGIN NOBYPASSRLS`);
    }
    await admin.query(`ALTER ROLE ${APP_GROUP_ROLE} NOLOGIN NOBYPASSRLS ${LOGIN_LIMITS}`);
    if (!(await roleExists(admin, PLATFORM_GROUP_ROLE))) {
      await admin.query(`CREATE ROLE ${PLATFORM_GROUP_ROLE} NOLOGIN NOBYPASSRLS`);
    }
    await admin.query(`ALTER ROLE ${PLATFORM_GROUP_ROLE} NOLOGIN NOBYPASSRLS ${LOGIN_LIMITS}`);

    // The app login: NOBYPASSRLS, a member of the group — table grants come
    // through the group (migration 062).
    await ensureLogin(admin, logins.app, 'NOBYPASSRLS', [logins.platform.user, PLATFORM_GROUP_ROLE]);
    // The platform login: BYPASSRLS on the login itself, since BYPASSRLS is
    // not inherited. Also a member of the group, so it holds the same table
    // privileges: BYPASSRLS skips policies, not GRANTs.
    await ensureLogin(admin, logins.platform, 'BYPASSRLS', []);
    // And the server's own tables, which `assistant_app` no longer reaches
    // (migration 068).
    await execFormatted(admin, `GRANT ${PLATFORM_GROUP_ROLE} TO %I`, [logins.platform.user]);

    const database = await currentDatabase(admin);
    for (const role of [APP_GROUP_ROLE, logins.app.user, logins.platform.user]) {
      await execFormatted(admin, 'GRANT CONNECT ON DATABASE %I TO %I', [database, role]);
    }
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${APP_GROUP_ROLE}`);

    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/**
 * Errors a concurrent `ensureRoles` on ANOTHER database of the same cluster
 * can cause: "tuple concurrently updated", a duplicate role name, a
 * serialization failure, a deadlock.
 */
const RETRYABLE = new Set(['XX000', '23505', '42710', '40001', '40P01']);

/**
 * Create or update the group role `assistant_app` and the two logins.
 * Idempotent, and safe to run from every test file.
 *
 * `admin` must be ONE connection (a checked-out client), not a pool: the
 * BEGIN/COMMIT and the advisory lock must land on one session.
 */
export async function ensureRoles(admin: Queryable, logins: RoleLogins): Promise<void> {
  assertRoleName(logins.app.user);
  assertRoleName(logins.platform.user);
  if (logins.app.user === logins.platform.user) {
    throw new Error('the app login and the platform login must be different roles');
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      await ensureRolesOnce(admin, logins);
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (attempt >= 5 || typeof code !== 'string' || !RETRYABLE.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

/** User and password of a connection URL. The URL itself is never printed. */
export function loginOf(url: string): RoleLogin {
  const parsed = new URL(url);
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntrypoint) {
  // Admin = DATABASE_MIGRATE_URL; the two logins come from DATABASE_URL and
  // DATABASE_PLATFORM_URL (or, under --test-db, the derived test logins).
  const client = await getMigratorPool().connect();
  try {
    const logins = {
      app: loginOf(config.databaseUrl),
      platform: loginOf(config.databasePlatformUrl),
    };
    await ensureRoles(client, logins);
    console.log(
      `roles ready: ${APP_GROUP_ROLE} (group), ${logins.app.user} (app), ${logins.platform.user} (platform, BYPASSRLS)`,
    );
  } finally {
    client.release();
    await closePool();
  }
}
