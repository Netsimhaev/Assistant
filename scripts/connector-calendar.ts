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

// `closePool()` in a `finally` below covers every exit from this point on,
// including a credential resolution that throws (fix-round 1, finding I5):
// this script's whole job is printing a readable line, not a stack trace,
// and a script that leaks the pool on the very first failure an
// unprovisioned install is expected to hit is not a readiness check.
try {
  const keyPath = process.env['CREDENTIAL_KEY_PATH'];
  if (keyPath === undefined || keyPath.length === 0) {
    console.log('MISS  CREDENTIAL_KEY_PATH — אין מפתח לפתוח בו את הסודות');
    process.exitCode = 1;
  } else {
    const key = await loadMasterKey(keyPath);
    const binding = (await loadBindings({ businessId })).find((b) => b.system === 'office-calendar');

    if (binding?.credentialRef == null) {
      // Final fix wave, item 7: this used to say "run scripts/seed-charter.ts"
      // with no further qualification, and that recovery step used to be
      // ACTIVELY DESTRUCTIVE — the old seed script declared `office-mail`
      // alone, so running it on an instance that already had a hand-installed
      // charter declaring `office-calendar` would supersede that charter with
      // one that dropped the calendar declaration entirely. `seed-charter.ts`
      // now declares BOTH connections and only ever supersedes a charter that
      // is missing one of them, so it is safe to name again — but the message
      // now says what a MISS here actually means (no binding row yet, i.e.
      // nobody has completed the consent ceremony) rather than implying the
      // charter itself is the thing missing.
      console.log(
        'MISS  office-calendar — טרם אושר: אין שורת binding עבור המערכת. ' +
          'ודא/י שהתקנון מצהיר עליה (scripts/seed-charter.ts — בטוח להרצה חוזרת, ' +
          'לא דורס חיבור קיים), ואז אשר/י גישה במסך /connections.',
      );
    } else {
      const credentials = oauthCredentials({
        key,
        fallback: storedCredentials(key),
        http: googleTokenHttp({ credentials: storedCredentials(key) }),
      });

      // `oauthCredentials.resolve` throws five error classes of its own
      // (`oauth-token.ts`) — a revoked grant, a rejected refresh, an
      // ambiguous ref, a missing local app secret, or a transient failure —
      // on top of whatever the fallback can throw. `live-thread-status.ts`
      // is the sibling to this: a readiness check whose whole job is
      // printing MISS lines should print one for this too, not stop with a
      // stack trace.
      let credential;
      try {
        credential = await credentials.resolve(binding.credentialRef, businessId);
      } catch (error) {
        console.log(
          `MISS  office-calendar — פתירת ההרשאה נכשלה: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
        credential = undefined;
      }

      if (credential !== undefined) {
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
        if (!result.ok) process.exitCode = 1;
      }
    }
  }
} catch (error) {
  console.log(`MISS  connector:calendar — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
