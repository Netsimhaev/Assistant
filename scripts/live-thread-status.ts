/**
 * Report whether this instance is ready to run the live thread.
 *
 * Read-only. Prints one line per prerequisite the runbook names, so an
 * operator can tell "not set up yet" from "set up and something else is
 * wrong" without reading five tables by hand.
 *
 *   npx tsx scripts/live-thread-status.ts
 */
import { config } from '../src/config.js';
import { closePool, getPool } from '../src/db/pool.js';
import { activeCharterVersion, loadActiveCharter } from '../src/charter/store.js';
import { DEFAULT_DASHBOARD_BASE_URL, redirectUriFor } from '../src/dashboard/oauth-routes.js';
import { loadBindings } from '../src/orchestrator/bindings.js';
import {
  GOOGLE_CLIENT_ID_REF,
  GOOGLE_CLIENT_SECRET_REF,
} from '../src/orchestrator/adapters/google-token-http.js';
import { listGrants } from '../src/governance/oauth-grants.js';
import { loadRampLevel } from '../src/orchestrator/ramp.js';
import { buildRuntime } from '../src/orchestrator/runtime.js';

function line(ok: boolean, label: string, detail: string): void {
  console.log(`${ok ? 'OK  ' : 'MISS'}  ${label.padEnd(26)} ${detail}`);
}

const businessId = config.businessId;
console.log(`business: ${businessId}\n`);

const charterVersion = await activeCharterVersion(businessId);
line(charterVersion !== null, 'charter installed', charterVersion ?? 'none — run scripts/seed-charter.ts');

const bindings = await loadBindings({ businessId });
const mail = bindings.find((b) => b.system === 'office-mail') ?? null;
line(
  mail?.status === 'live',
  'office-mail binding',
  mail === null ? 'no row — run scripts/seed-charter.ts' : `status=${mail.status} credentialRef=${mail.credentialRef ?? 'null'}`,
);

// `must_change_password` lives on dashboard_sessions, not dashboard_users —
// migration 009 puts it there deliberately, because the only session that
// needs the flag is the one minted right after a recovery redemption.
const owners = await getPool().query<{ username: string; locked_until: Date | null }>(
  'SELECT username, locked_until FROM dashboard_users WHERE business_id = $1',
  [businessId],
);
const owner = owners.rows[0];
line(
  owner !== undefined,
  'dashboard owner',
  owner === undefined
    ? 'none — run `npm run owner:create`'
    : `${owner.username}${owner.locked_until ? ` (LOCKED until ${owner.locked_until.toISOString()})` : ''}`,
);

// `await`, which this line lacked: `buildRuntime` has been async since before
// the credential store was wired to the mail path, so the un-awaited call left
// `runtime` a Promise and the next line died with
// `TypeError: Cannot read properties of undefined (reading 'get')` — the
// runbook's own "run this first" step, crashing. It also hid `MasterKeyError`:
// a missing key file surfaced as that TypeError instead of as the refusal it
// is. Caught rather than left to reject, because a readiness check whose whole
// job is printing MISS lines should print one for the key too, not stop with a
// stack trace before the remaining checks run.
let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
try {
  runtime = await buildRuntime();
} catch (error) {
  line(false, 'credential key', error instanceof Error ? error.message : String(error));
}

if (runtime !== null) {
  line(true, 'credential key', 'loaded and verified');
  line(runtime.registry.get('office-mail') !== null, 'mail adapter built', runtime.registry.systems().join(', '));
  line(runtime.notify !== undefined, 'approval notifier', runtime.notify ? `link base ${runtime.notify.dashboardBaseUrl}` : 'not built');

  // "The adapter was built" says the five SMTP variables are set; it says
  // nothing about whether the secret they authenticate with exists. An
  // unprovisioned ref read as ready here, and then every `mail.send` failed
  // with `credential_unavailable` at run time — the one failure this script's
  // own table tells the operator to expect. Both refs are checked: the
  // binding's (whatever `credential_ref` the row carries) and the notifier's
  // (`NOTIFY_CREDENTIAL_REF`), because they are resolved by different callers
  // and either can be missing on its own.
  const refs = new Set<string>();
  if (mail?.credentialRef) refs.add(mail.credentialRef);
  const notifyRef = process.env['NOTIFY_CREDENTIAL_REF'];
  if (notifyRef !== undefined && notifyRef.length > 0) refs.add(notifyRef);
  // The OAuth consent ceremony's own app secret (oauth-routes.ts,
  // oauth-consent.ts) — resolved unconditionally, not only when a Google
  // binding already exists, because the FIRST thing an operator needs to
  // know before clicking "connect" on the dashboard is whether these are
  // provisioned at all.
  refs.add(GOOGLE_CLIENT_ID_REF);
  refs.add(GOOGLE_CLIENT_SECRET_REF);
  for (const ref of refs) {
    const handle = await runtime.credentials.resolve(ref, businessId);
    line(
      handle !== null,
      `secret ${ref}`,
      handle === null ? `not provisioned — run \`npm run secret put ${ref} <operator>\`` : 'provisioned',
    );
  }

  for (const warning of runtime.warnings) console.log(`      warning: ${warning}`);
}

// The single most common installation failure for the OAuth consent
// ceremony (spec 5.5): the redirect_uri registered at the provider must
// match this, character for character. Printed unconditionally, before a
// run, rather than surfacing as an opaque `redirect_uri_mismatch` from
// Google mid-consent.
const dashboardBaseUrlForOAuth = process.env['DASHBOARD_BASE_URL'] ?? DEFAULT_DASHBOARD_BASE_URL;
console.log(`\noauth redirect_uri: ${redirectUriFor(dashboardBaseUrlForOAuth)}`);

// One line per connection the CHARTER declares — not per binding, and not
// per grant: a connection the owner signed but never authorised is exactly
// the state an operator needs to see before a run, not discover as
// `credential_unavailable` mid-run. `listGrants` returns `OAuthGrantSummary`,
// which carries no refresh token at all (see `governance/oauth-grants.ts`) —
// it cannot leak one here even by a future mistake in this script.
//
// Caught rather than left to reject, same discipline as the `buildRuntime`
// call above and for the identical reason: a stored charter whose
// schemaVersion the running code no longer understands is a real, nameable
// state (`loadActiveCharter`'s own error says exactly which way to fix it),
// and a readiness script whose whole job is printing MISS lines must print
// one for this too, not stop with a stack trace before the remaining checks
// run.
let active: Awaited<ReturnType<typeof loadActiveCharter>> | null = null;
try {
  active = await loadActiveCharter(businessId);
} catch (error) {
  line(false, 'declared connections', error instanceof Error ? error.message : String(error));
}
if (active !== null) {
  const grants = await listGrants(businessId);
  const grantBySystem = new Map(grants.map((g) => [g.system, g] as const));
  console.log('\ndeclared connections:');
  for (const conn of active.bundle.connections) {
    const grant = grantBySystem.get(conn.system);
    const detail =
      grant === undefined
        ? 'no grant — connect it from /connections'
        : grant.revokedAt !== null
          ? `revoked at ${grant.revokedAt} — reconnect from /connections`
          : grant.needsReauthAt !== null
            ? `needs re-authorisation since ${grant.needsReauthAt} — reconnect from /connections`
            : `granted to ${grant.account} (${grant.provider})`;
    line(
      grant !== undefined && grant.revokedAt === null && grant.needsReauthAt === null,
      `connection ${conn.system}`,
      detail,
    );
  }
  if (active.bundle.connections.length === 0) {
    console.log('      (none declared in the charter)');
  }
}

const ramp = await loadRampLevel('email.initiate', { businessId });
line(true, 'ramp email.initiate', `${ramp} (job:seed raises it to approve_required)`);

const jobs = await getPool().query<{ phase: string; count: string }>(
  `SELECT phase, count(*)::text AS count FROM jobs
    WHERE business_id = $1 AND closed_at IS NULL GROUP BY phase ORDER BY phase`,
  [businessId],
);
console.log(
  `\nopen jobs: ${jobs.rows.length === 0 ? 'none' : jobs.rows.map((r) => `${r.phase}=${r.count}`).join(' ')}`,
);

// Quiet hours are enforced against the charter's own timezone, and the gate
// checks them BEFORE autonomy — so an evening run parks the job silently.
// Printing the local time here is what turns "nothing happened" into a
// readable answer, which is the whole reason this script exists.
const jerusalem = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
}).format(new Date());
const hour = Number(jerusalem.slice(0, 2));
const quiet = hour >= 20 || hour < 7;
console.log(
  `Asia/Jerusalem now: ${jerusalem} — ${quiet ? 'INSIDE quiet hours (20:00-07:00): a run now parks silently' : 'outside quiet hours: safe to run'}`,
);

await closePool();
