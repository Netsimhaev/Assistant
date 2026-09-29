/**
 * Install a charter declaring both connections the live thread needs — mail
 * and calendar — and mark the mail binding `live`, once, by hand.
 *
 * There is no charter-authoring CLI yet, so this uses `buildCharter` from the
 * test fixtures — not because it is a test, but because it is currently the
 * only way to produce a signed charter that `installCharter` will accept.
 * Both this and the real charter editor are work that follows the live
 * thread, not defects in it. See docs/live-thread-runbook.md §3.
 *
 * Safe to run twice, but NOT because `installCharter` is idempotent — it is
 * not. `charter_versions.charter_version` is the primary key **on its own**,
 * not paired with `business_id`, so re-installing a fixture whose version
 * string is a constant fails with a unique violation the second time. This
 * script therefore checks for an active charter first and skips the install.
 *
 *   npx tsx scripts/seed-charter.ts
 */
import { installCharter, probeActiveCharter } from '../src/charter/store.js';
import { buildCharter } from '../src/test/fixtures.js';
import { upsertBinding } from '../src/orchestrator/bindings.js';
import { closePool } from '../src/db/pool.js';
import { config } from '../src/config.js';
import type { CharterConnection } from '../src/domain/connection.js';

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

/**
 * Added in the final fix wave (item 7). Before this, this script declared
 * `MAIL_CONNECTION` alone, so the connections screen showed only "חיבור
 * דואר" — no calendar row, no calendar link — and the runbook had to ask the
 * operator to hand-write a variant script to get one. `channel: 'api'`,
 * matching `MAIL_CONNECTION`: both are real API connections, never the
 * browser channel.
 */
const CALENDAR_CONNECTION: CharterConnection = {
  system: 'office-calendar',
  label: 'יומן המשרד',
  channel: 'api',
  serves: ['calendar.read'],
  target: null,
  subprocessor: null,
};

/**
 * An active charter is not enough — it has to DECLARE both connections.
 *
 * The registry can only narrow: a `connection_bindings` row cannot grant a
 * channel the charter never named, so a charter with `connections: []` plus a
 * live binding still resolves to `no_channel_for_tool` and the plan is
 * rejected before anything is sent. This instance was found in exactly that
 * state — an earlier session had installed the fixture charter with no
 * connections at all.
 *
 * **The skip condition requires BOTH connections, not just mail (final fix
 * wave, item 7) — this is the fix, not a strengthening for its own sake.**
 * The old condition (`declaresMail` alone) meant: an operator who had
 * hand-installed a charter declaring `office-calendar` ONLY would see
 * `declaresMail === false`, and this script would supersede that charter
 * with one declaring `office-mail` only — DROPPING the calendar declaration
 * the operator had just set up, silently, because nothing here looked at it.
 * Requiring both before skipping means this script can install a charter
 * missing either connection, but can never REPLACE a charter that already
 * declares one of them with a charter that declares only the other.
 *
 * Re-installing under the same version string is impossible
 * (`charter_versions.charter_version` is the primary key on its own), so a
 * charter missing either connection is superseded by a new version that
 * declares both, instead.
 */
/**
 * Probed rather than loaded, because this script IS the recovery path.
 *
 * `loadActiveCharter` throws on a charter this code cannot read — correct
 * everywhere in production, and fatal here: an installation whose charter had
 * fallen behind the schema could not be repaired, because the repair began by
 * reading the thing that was broken. An unreadable charter answers this
 * script's only question ("is a correct charter already installed?") with a
 * plain no.
 */
const probe = await probeActiveCharter(config.businessId);
if (!probe.ok) {
  console.log(`active charter could not be read, so it will be superseded: ${probe.reason}`);
}
const active = probe.ok ? probe.active : null;
const declaresMail = active?.charter.connections.some((c) => c.system === MAIL_CONNECTION.system) === true;
const declaresCalendar =
  active?.charter.connections.some((c) => c.system === CALENDAR_CONNECTION.system) === true;

if (declaresMail && declaresCalendar) {
  console.log(
    `charter already active and declares ${MAIL_CONNECTION.system} and ${CALENDAR_CONNECTION.system}: ` +
      `${active?.charter.charterVersion} — install skipped`,
  );
} else {
  // A version string that is unique per run, so this never collides with a
  // version some earlier session already inserted.
  const version = `live-thread-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
  const bundle = await installCharter(
    buildCharter({ version, connections: [MAIL_CONNECTION, CALENDAR_CONNECTION] }),
  );
  console.log(
    active === null
      ? `charter installed for ${config.businessId}: ${bundle.charterVersion}`
      : `previous charter ${active.charter.charterVersion} did not declare both connections; ` +
          `installed ${bundle.charterVersion} which declares ${MAIL_CONNECTION.system} and ` +
          `${CALENDAR_CONNECTION.system}`,
  );
}

// `credentialRef` is OFFICE_MAIL, and production resolves that ref through
// `storedCredentials` (`src/governance/credential-store.ts`) — the encrypted
// per-business table, provisioned with `npm run secret put OFFICE_MAIL
// <operator>`. This comment used to name `envCredentials` and its
// `ASSISTANT_CREDENTIAL_OFFICE_MAIL` variable, which exists for tests only and
// runs nowhere in production; the runbook runs this script, so an operator
// reading it was being pointed at an environment variable that resolves
// nothing.
await upsertBinding(
  {
    system: 'office-mail',
    status: 'live',
    endpoint: null,
    credentialRef: 'OFFICE_MAIL',
    provider: null,
    lastOkAt: null,
    lastError: null,
  },
  { by: 'runbook' },
);
console.log('binding office-mail set to live (credentialRef OFFICE_MAIL)');

// No binding write for `office-calendar` here, deliberately: unlike mail's
// static secret, the calendar connection is OAuth-backed, and its binding
// (`provider: 'google'`, `credentialRef`) is written by `handleOAuthCallback`
// (`src/dashboard/oauth-routes.ts`) only once the owner actually completes
// the consent ceremony at `/oauth/office-calendar/start`. Writing a binding
// row here, ahead of that, would claim a connection is live when nobody has
// authorised anything yet.
console.log('office-calendar declared in the charter — authorise it from the /connections screen');

await closePool();
