/**
 * Prove the configured mail path actually reaches the local catcher.
 *
 * Throwaway verification, not part of the product: it builds the SAME runtime
 * the scheduler builds, pulls the mail adapter out of it, and sends one
 * message through it. If this fails, the live thread would fail tomorrow at
 * the same point — better to learn it now than to spend the morning on it.
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

const runtime = buildRuntime();
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
