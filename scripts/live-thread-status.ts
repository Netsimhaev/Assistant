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
import { activeCharterVersion } from '../src/charter/store.js';
import { loadBindings } from '../src/orchestrator/bindings.js';
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

const runtime = buildRuntime();
line(runtime.registry.get('office-mail') !== null, 'mail adapter built', runtime.registry.systems().join(', '));
line(runtime.notify !== undefined, 'approval notifier', runtime.notify ? `link base ${runtime.notify.dashboardBaseUrl}` : 'not built');
for (const warning of runtime.warnings) console.log(`      warning: ${warning}`);

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
