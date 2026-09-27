/**
 * Install a charter and mark the mail connection `live`, once, by hand.
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
 * An active charter is not enough — it has to DECLARE the mail connection.
 *
 * The registry can only narrow: a `connection_bindings` row cannot grant a
 * channel the charter never named, so a charter with `connections: []` plus a
 * live binding still resolves to `no_channel_for_tool` and the plan is
 * rejected before anything is sent. This instance was found in exactly that
 * state — an earlier session had installed the fixture charter with no
 * connections at all.
 *
 * Re-installing under the same version string is impossible
 * (`charter_versions.charter_version` is the primary key on its own), so a
 * charter that lacks the connection is superseded by a new version instead.
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

if (declaresMail) {
  console.log(
    `charter already active and declares ${MAIL_CONNECTION.system}: ${active?.charter.charterVersion} — install skipped`,
  );
} else {
  // A version string that is unique per run, so this never collides with a
  // version some earlier session already inserted.
  const version = `live-thread-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
  const bundle = await installCharter(
    buildCharter({ version, connections: [MAIL_CONNECTION] }),
  );
  console.log(
    active === null
      ? `charter installed for ${config.businessId}: ${bundle.charterVersion}`
      : `previous charter ${active.charter.charterVersion} declared no connections; installed ${bundle.charterVersion} which declares ${MAIL_CONNECTION.system}`,
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
    lastOkAt: null,
    lastError: null,
  },
  { by: 'runbook' },
);
console.log('binding office-mail set to live (credentialRef OFFICE_MAIL)');

await closePool();
