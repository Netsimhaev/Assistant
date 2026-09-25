/**
 * Prove the configured mail path actually reaches the local catcher.
 *
 * Throwaway verification, not part of the product: it builds the SAME runtime
 * the scheduler builds, pulls the mail adapter out of it, and sends one
 * message through it. If this fails, the live thread would fail tomorrow at
 * the same point — better to learn it now than to spend the morning on it.
 *
 * **Needs a provisioned secret.** It reads the value from
 * `ASSISTANT_CREDENTIAL_OFFICE_MAIL` in the process environment rather than
 * from the encrypted store, which is not how production resolves anything —
 * `storedCredentials` is (`src/governance/credential-store.js`). Unset, the
 * handle carries an empty string and `createSmtpTransport` refuses the send
 * outright, so this prints FAIL without ever opening a socket. To probe the
 * real path instead, run `npx tsx scripts/live-thread-status.ts`, which
 * resolves the same refs the way the scheduler does.
 *
 *   npx tsx scripts/probe-smtp.ts
 */
// `.env` is loaded as a side effect of importing config. `runtime.ts` does
// not import it, so without this line `buildRuntime` reads an empty
// process.env and reports every SMTP variable missing. In production
// `run-scheduler.ts` imports config, so this is a property of the probe, not
// of the runtime.
import '../src/config.js';
import { buildRuntime } from '../src/orchestrator/runtime.js';
import { createCredentialHandle } from '../src/orchestrator/adapters/types.js';

// `await`: `buildRuntime` is async (it reads the master key file), and without
// this the next line read `.warnings` off a Promise and the one after it died
// with a TypeError about `undefined`. A missing or unreadable key file now
// surfaces as the `MasterKeyError` it is.
const runtime = await buildRuntime();
for (const warning of runtime.warnings) console.log(`warning: ${warning}`);

const adapter = runtime.registry.get('office-mail');
if (adapter === null) {
  console.log('RESULT FAIL: no office-mail adapter in the runtime');
  process.exit(1);
}

const result = await adapter.execute({
  toolName: 'mail.send',
  input: {
    to: ['owner@example.com'],
    subject: 'בדיקת חיווט — החוט החי',
    body: 'אם ההודעה הזו מופיעה ב-maildev, מסלול הדואר מוגדר נכון.',
  },
  endpoint: null,
  credential: createCredentialHandle('OFFICE_MAIL', process.env['ASSISTANT_CREDENTIAL_OFFICE_MAIL'] ?? ''),
  idempotencyKey: 'probe-smtp-1',
  signal: AbortSignal.timeout(10_000),
});

console.log(`RESULT ${result.ok ? 'OK' : 'FAIL'} ${JSON.stringify(result)}`);
process.exit(result.ok ? 0 : 1);
