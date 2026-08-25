import { describe, expect, it } from 'vitest';
import { buildRuntime } from './runtime.js';

const FULL = {
  MAIL_SYSTEM: 'office-mail',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'false',
  SMTP_FROM: 'assistant@example.com',
  SMTP_USER: 'assistant',
  SMTP_PASS: 'pw',
  APPROVAL_NOTIFY_TO: 'boss@example.com',
  DASHBOARD_BASE_URL: 'http://127.0.0.1:8787',
};

describe('buildRuntime', () => {
  it('registers a mail adapter under the configured system name', () => {
    const runtime = buildRuntime(FULL);
    expect(runtime.registry.get('office-mail')).not.toBeNull();
    expect(runtime.warnings).toEqual([]);
  });

  it('builds a notifier when a destination and SMTP are both configured', () => {
    const runtime = buildRuntime(FULL);
    expect(runtime.notify?.notifier.channel).toBe('email');
    expect(runtime.notify?.dashboardBaseUrl).toBe('http://127.0.0.1:8787');
  });

  it('warns loudly rather than silently omitting the mail adapter', () => {
    const { SMTP_HOST: _host, ...withoutHost } = FULL;
    const runtime = buildRuntime(withoutHost);
    expect(runtime.registry.get('office-mail')).toBeNull();
    expect(runtime.warnings.join(' ')).toMatch(/SMTP_HOST/);
  });

  it('warns when SMTP is configured but nobody is set to receive notifications', () => {
    const { APPROVAL_NOTIFY_TO: _to, ...withoutTo } = FULL;
    const runtime = buildRuntime(withoutTo);
    expect(runtime.notify).toBeUndefined();
    expect(runtime.warnings.join(' ')).toMatch(/APPROVAL_NOTIFY_TO/);
  });

  it('always supplies a credential source', () => {
    const runtime = buildRuntime({});
    expect(typeof runtime.credentials.resolve).toBe('function');
  });

  it('treats an explicitly-empty MAIL_SYSTEM as unset, not as a literal empty system id', () => {
    // `??` alone accepts `''`, and an adapter registered under an empty
    // system id can never be matched by `resolveChannel` — every mail.send
    // step would fail silently, with no warning at all, because the earlier
    // check only looks at the SMTP_* keys. Empty must fall back to the
    // default, exactly like every other value this function reads.
    const runtime = buildRuntime({ ...FULL, MAIL_SYSTEM: '' });
    expect(runtime.registry.get('office-mail')).not.toBeNull();
  });

  it('treats an explicitly-empty DASHBOARD_BASE_URL as unset, not as a literal empty link', () => {
    const runtime = buildRuntime({ ...FULL, DASHBOARD_BASE_URL: '' });
    expect(runtime.notify?.dashboardBaseUrl).toBe('http://127.0.0.1:8787');
  });

  it('registers the browser driver as the browser channel default', () => {
    const runtime = buildRuntime(FULL);
    // AdapterRegistry.systems() lists system-specific entries under their
    // bare system id and channel defaults prefixed `channel:` (see that
    // method's docblock). Asserting `channel:browser` is present fails if
    // browserAdapter were dropped entirely, and asserting plain `browser` is
    // absent fails if it were registered as a system adapter instead.
    expect(runtime.registry.systems()).toContain('channel:browser');
    expect(runtime.registry.systems()).not.toContain('browser');
  });
});
