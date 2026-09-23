import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { putSecret } from '../governance/credential-store.js';
import { KEY_BYTES, MasterKeyError, writeKeyState } from '../governance/master-key.js';
import { DEFAULT_CREDENTIAL_ENV_PREFIX } from './credentials.js';
import { resetDatabase } from '../test/db.js';
import { buildRuntime } from './runtime.js';

const BASE = {
  MAIL_SYSTEM: 'office-mail',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'false',
  SMTP_FROM: 'assistant@example.com',
  SMTP_USER: 'assistant',
  SMTP_PASS: 'pw',
  APPROVAL_NOTIFY_TO: 'boss@example.com',
  DASHBOARD_BASE_URL: 'http://127.0.0.1:8787',
  ANTHROPIC_API_KEY: 'sk-test-key',
};

let DIR: string;
let KEY: Buffer;
/** `BASE` plus the key path — what a correctly configured install looks like. */
let FULL: Record<string, string>;

beforeEach(async () => {
  await resetDatabase();
  DIR = await mkdtemp(join(tmpdir(), 'runtime-key-'));
  KEY = randomBytes(KEY_BYTES);
  const keyPath = join(DIR, 'master.key');
  await writeFile(keyPath, KEY, { mode: 0o600 });
  await writeKeyState(KEY, 'key-1');
  FULL = { ...BASE, CREDENTIAL_KEY_PATH: keyPath };
});

afterEach(async () => {
  await rm(DIR, { recursive: true, force: true });
});

afterAll(async () => {
  await closePool();
});

describe('buildRuntime', () => {
  it('registers a mail adapter under the configured system name', async () => {
    const runtime = await buildRuntime(FULL);
    expect(runtime.registry.get('office-mail')).not.toBeNull();
    expect(runtime.warnings).toEqual([]);
  });

  it('builds a notifier when a destination and SMTP are both configured', async () => {
    const runtime = await buildRuntime(FULL);
    expect(runtime.notify?.notifier.channel).toBe('email');
    expect(runtime.notify?.dashboardBaseUrl).toBe('http://127.0.0.1:8787');
  });

  it('warns loudly rather than silently omitting the mail adapter', async () => {
    const { SMTP_HOST: _host, ...withoutHost } = FULL;
    const runtime = await buildRuntime(withoutHost);
    expect(runtime.registry.get('office-mail')).toBeNull();
    expect(runtime.warnings.join(' ')).toMatch(/SMTP_HOST/);
  });

  it('warns when SMTP is configured but nobody is set to receive notifications', async () => {
    const { APPROVAL_NOTIFY_TO: _to, ...withoutTo } = FULL;
    const runtime = await buildRuntime(withoutTo);
    expect(runtime.notify).toBeUndefined();
    expect(runtime.warnings.join(' ')).toMatch(/APPROVAL_NOTIFY_TO/);
  });

  it('warns when ANTHROPIC_API_KEY is absent, so curation-off does not look like nothing-to-remember', async () => {
    const { ANTHROPIC_API_KEY: _key, ...withoutKey } = FULL;
    const runtime = await buildRuntime(withoutKey);
    expect(runtime.warnings.join(' ')).toMatch(/ANTHROPIC_API_KEY/);
    // Unrelated to the mail adapter — a missing model key must not also
    // suppress the mail warning path or vice versa.
    expect(runtime.registry.get('office-mail')).not.toBeNull();
  });

  it('always supplies a credential source', async () => {
    const runtime = await buildRuntime({ CREDENTIAL_KEY_PATH: FULL['CREDENTIAL_KEY_PATH'] as string });
    expect(typeof runtime.credentials.resolve).toBe('function');
  });

  it('treats an explicitly-empty MAIL_SYSTEM as unset, not as a literal empty system id', async () => {
    // `??` alone accepts `''`, and an adapter registered under an empty
    // system id can never be matched by `resolveChannel` — every mail.send
    // step would fail silently, with no warning at all, because the earlier
    // check only looks at the SMTP_* keys. Empty must fall back to the
    // default, exactly like every other value this function reads.
    const runtime = await buildRuntime({ ...FULL, MAIL_SYSTEM: '' });
    expect(runtime.registry.get('office-mail')).not.toBeNull();
  });

  it('treats an explicitly-empty DASHBOARD_BASE_URL as unset, not as a literal empty link', async () => {
    const runtime = await buildRuntime({ ...FULL, DASHBOARD_BASE_URL: '' });
    expect(runtime.notify?.dashboardBaseUrl).toBe('http://127.0.0.1:8787');
  });

  it('registers the browser driver as the browser channel default', async () => {
    const runtime = await buildRuntime(FULL);
    // AdapterRegistry.systems() lists system-specific entries under their
    // bare system id and channel defaults prefixed `channel:` (see that
    // method's docblock). Asserting `channel:browser` is present fails if
    // browserAdapter were dropped entirely, and asserting plain `browser` is
    // absent fails if it were registered as a system adapter instead.
    expect(runtime.registry.systems()).toContain('channel:browser');
    expect(runtime.registry.systems()).not.toContain('browser');
  });

  /**
   * Spec §3.4/§9.5 — a POSITIVE control that the source production assembles
   * is the encrypted store and not the tests' `envCredentials`.
   *
   * Asserted as behaviour on both sides, because either half alone would
   * pass for the wrong reason: the stored secret resolving proves the store
   * is wired, and the environment-only ref NOT resolving proves
   * `envCredentials` is not. A rewiring back to `envCredentials(env)` fails
   * both assertions; one that supplied both sources would fail the second.
   */
  it('resolves secrets from the encrypted store, and not from the process environment', async () => {
    await putSecret(
      {
        businessId: config.businessId,
        ref: 'OFFICE_MAIL',
        value: 'sealed-in-the-database',
        updatedBy: 'operator@example.com',
      },
      KEY,
    );

    const runtime = await buildRuntime({
      ...FULL,
      // Exactly the shape `envCredentials` reads. Stored nowhere else.
      [`${DEFAULT_CREDENTIAL_ENV_PREFIX}DECOY`]: 'from-the-environment',
    });

    const stored = await runtime.credentials.resolve('OFFICE_MAIL', config.businessId);
    expect(stored?.value).toBe('sealed-in-the-database');
    expect(await runtime.credentials.resolve('DECOY', config.businessId)).toBeNull();
  });

  /**
   * Spec §4.2 — an install with no key does not start. The alternative is an
   * install that runs and fails one customer at a time, in a way that looks
   * like network trouble.
   */
  it('refuses to build at all when no key file is configured', async () => {
    const { CREDENTIAL_KEY_PATH: _path, ...withoutKeyPath } = FULL;
    await expect(buildRuntime(withoutKeyPath)).rejects.toThrow(MasterKeyError);
    await expect(buildRuntime({ ...FULL, CREDENTIAL_KEY_PATH: '' })).rejects.toThrow(
      MasterKeyError,
    );
  });

  /**
   * Spec §5.1 — the wrong key is caught at startup, by `verifyKeyState`
   * running here, rather than at the first secret a customer needs.
   */
  it('refuses to build when the key file is not the key this installation sealed its rows with', async () => {
    const wrongPath = join(DIR, 'wrong.key');
    await writeFile(wrongPath, randomBytes(KEY_BYTES), { mode: 0o600 });

    await expect(
      buildRuntime({ ...FULL, CREDENTIAL_KEY_PATH: wrongPath }),
    ).rejects.toThrow(MasterKeyError);
    // …and the right one still builds, so the refusal above is the key and
    // not something that makes every build fail.
    await expect(buildRuntime(FULL)).resolves.toBeDefined();
  });
});
