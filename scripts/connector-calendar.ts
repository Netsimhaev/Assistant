/**
 * Drive the real chain against Google's calendar API: charter, binding,
 * grant, minted access token, one `calendar.read` call — the live thread's
 * proof for the connector spine.
 *
 * `CREDENTIAL_KEY_PATH` is read directly from `process.env`, the same way
 * `src/cli/secret.ts` reads it — `config` does not expose it under any
 * field name, and this script does not invent one.
 *
 *   npx tsx scripts/connector-calendar.ts
 */
import { config } from '../src/config.js';
import { closePool } from '../src/db/pool.js';
import { loadBindings } from '../src/orchestrator/bindings.js';
import { createGoogleCalendarAdapter } from '../src/orchestrator/adapters/google-calendar.js';
import { googleTokenHttp } from '../src/orchestrator/adapters/google-token-http.js';
import { oauthCredentials } from '../src/orchestrator/oauth-token.js';
import { storedCredentials } from '../src/governance/credential-store.js';
import { loadMasterKey } from '../src/governance/master-key.js';

const businessId = config.businessId;

const keyPath = process.env['CREDENTIAL_KEY_PATH'];
if (keyPath === undefined || keyPath.length === 0) {
  console.log('MISS  CREDENTIAL_KEY_PATH — אין מפתח לפתוח בו את הסודות');
  await closePool();
  process.exit(1);
}
const key = await loadMasterKey(keyPath);

const binding = (await loadBindings({ businessId })).find((b) => b.system === 'office-calendar');

if (binding?.credentialRef == null) {
  console.log('MISS  office-calendar — הרץ scripts/seed-charter.ts, ואז אשר גישה במסך החיבורים');
} else {
  const credentials = oauthCredentials({
    key,
    fallback: storedCredentials(key),
    http: googleTokenHttp({ credentials: storedCredentials(key), businessId }),
  });
  const credential = await credentials.resolve(binding.credentialRef, businessId);
  const adapter = createGoogleCalendarAdapter({ system: 'office-calendar' });
  const result = await adapter.execute({
    toolName: 'calendar.read',
    input: {},
    credential,
    endpoint: binding.endpoint,
    idempotencyKey: `manual-${Date.now()}`,
    signal: AbortSignal.timeout(20_000),
  });
  console.log(JSON.stringify(result, null, 2));
}
await closePool();
