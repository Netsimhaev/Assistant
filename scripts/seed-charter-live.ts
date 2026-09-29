/**
 * A charter for one unattended live run, 25/08.
 *
 * Three deliberate differences from `seed-charter.ts`, each of which changes
 * what the run proves — so each is named here rather than buried:
 *
 * 1. **The quiet window is moved to 03:00–04:00.** The fixture's is
 *    20:00–07:00 on `email`, and this run starts at 20:00 exactly, so the gate
 *    would deny at stage 7 (`quiet_hours`), park the job in `followup` with
 *    `wakeAt` at 07:00, and send nothing. Quiet hours are the owner's to
 *    declare, so declaring a different window is configuration, not a bypass —
 *    but this run therefore proves nothing about quiet-hours enforcement.
 * 2. **`example.com` is a known counterparty.** `seedMailJob` writes no
 *    `counterpartyId`, so against the stock fixture `dana@example.com` scores
 *    `one_unknown`, `bandFor` escalates to `sensitive`, and the gate demands
 *    an approval *even under `auto`*. Making the domain known is what leaves
 *    the ramp as the only ceiling in play.
 * 3. **`email.initiate` is `auto` at the base.** `effectiveAutonomy` takes the
 *    most restrictive of base, provenance ceiling and ramp; leaving the base
 *    at `approve_required` would out-vote the ramp.
 *
 * `buildCharter` signs what it returns and exposes no quiet-hours override, so
 * the signature is dropped, the window replaced, and the whole thing re-signed
 * — the hash must cover what is actually installed.
 *
 * **It also drops any connection the previous charter declared other than
 * `office-mail`** -- `office-calendar`, in an installation that followed
 * runbook section 10. That is a consequence of superseding with a
 * single-connection charter rather than a fourth deliberate difference, and
 * it is warned about rather than prevented; the comment beside the warning
 * itself says why a skip condition is not the fix here.
 *
 *   npx tsx scripts/seed-charter-live.ts
 */
import { installCharter, probeActiveCharter } from '../src/charter/store.js';
import { signCharter } from '../src/charter/sign.js';
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

const version = `live-auto-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '')}`;

const signed = buildCharter({
  version,
  connections: [MAIL_CONNECTION],
  knownCounterpartyEmailDomain: 'example.com',
  autonomyBase: { 'email.initiate': 'auto' },
});

const { signature: _dropped, ...unsigned } = signed;
const charter = signCharter(
  {
    ...unsigned,
    operations: {
      ...unsigned.operations,
      quietHours: { from: '03:00', to: '04:00', appliesTo: ['email', 'whatsapp'] },
    },
  },
  { signedByPersonId: 'owner', method: 'dashboard_click' },
);

// Probed, not loaded — see the same call in `seed-charter.ts`: a script whose
// job is to install a charter must not be stopped by the charter it replaces.
const probe = await probeActiveCharter(config.businessId);
const previous = probe.ok ? probe.active : null;
if (!probe.ok) console.log(`previous charter is unreadable and will be superseded: ${probe.reason}`);
const bundle = await installCharter(charter);
console.log(
  previous === null
    ? `charter installed: ${bundle.charterVersion}`
    : `superseded ${previous.charter.charterVersion} with ${bundle.charterVersion}`,
);
console.log('quiet hours:', charter.operations.quietHours);

// The charter installed above declares `office-mail` ONLY, and it supersedes
// unconditionally -- that is this script's purpose, not an oversight: the
// three differences named at the top are what the run proves.
//
// But both `scripts/seed-charter.ts` and the consent ceremony in runbook
// section 10 leave `office-calendar` declared, and dropping a declaration
// puts the grant the owner authorised out of reach: the `oauth_grants` row
// survives untouched, and every later `calendar.read` step is refused at
// `no_channel_for_tool`, because the registry can only narrow (`CLAUDE.md`).
//
// Skipping the install the way `seed-charter.ts` does is NOT available here.
// That script installs the ordinary charter, so declining to replace a
// charter which already declares both systems costs nothing; this one exists
// to replace whatever is active with a deliberately permissive charter
// (`email.initiate: auto`), and a skip condition would make the live run it
// exists for impossible to set up. So the drop stays and the silence goes:
// name what was dropped, and name the one command that restores it.
const dropped = (previous?.charter.connections ?? [])
  .map((c) => c.system)
  .filter((system) => system !== MAIL_CONNECTION.system);
if (dropped.length > 0) {
  console.warn(
    `warning: the previous charter declared ${dropped.join(', ')} and this one does not — ` +
      'any OAuth grant authorised for those systems is now unreachable (no_channel_for_tool). ' +
      'Restore both declarations with: npx tsx scripts/seed-charter.ts',
  );
}

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
  { by: 'live-run' },
);
console.log('binding office-mail: live');

await closePool();
