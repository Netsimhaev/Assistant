import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import type { CharterConnection } from '../domain/connection.js';
import type { ApprovalRequest } from '../governance/approvals.js';
import { putSecret } from '../governance/credential-store.js';
import { KEY_BYTES, MasterKeyError, writeKeyState } from '../governance/master-key.js';
import type { RiskAssessment } from '../domain/risk.js';
import { upsertBinding } from './bindings.js';
import { DEFAULT_CREDENTIAL_ENV_PREFIX } from './credentials.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { createFakeGateway } from '../whatsapp/fake-gateway.js';
import { buildRuntime } from './runtime.js';

const BUSINESS = config.businessId;

const CALENDAR_CONNECTION: CharterConnection = {
  system: 'office-calendar',
  label: 'יומן המשרד',
  channel: 'api',
  serves: ['calendar.read'],
  target: null,
  subprocessor: null,
};

const BASE = {
  MAIL_SYSTEM: 'office-mail',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'false',
  SMTP_FROM: 'assistant@example.com',
  SMTP_USER: 'assistant',
  NOTIFY_CREDENTIAL_REF: 'NOTIFY_MAIL',
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

/**
 * Just enough of a `RiskAssessment`/`ApprovalRequest` for `notify()` to build
 * a message from — the values themselves are inert, only the notifier's
 * *wiring* (which ref, which store, does it reach the transport) is under
 * test here. Deliberately not routed through `enqueueApproval`: this file is
 * not re-testing the approval pipeline, only what `buildRuntime` hands
 * `createEmailNotifier`.
 */
function riskFixture(): RiskAssessment {
  return {
    actionId: 'A-test',
    actionClass: 'purchase.place',
    dimensions: {
      money: { amountMinor: 0, pctOfDailyCeiling: 0, score: 0 },
      reversibility: { class: 'reversible', score: 0 },
      externalVisibility: { audience: 'one_known', score: 0 },
      dataSensitivity: { classes: [], leavesInstance: false, score: 0 },
      novelty: { metric: null, z: 0, precedentIds: [], score: 0 },
      provenance: { level: 'boss', chainDepth: 0, score: 0 },
      charterFit: { verdict: 'within', citedRuleIds: [], score: 0 },
    },
    total: 0,
    band: 'routine',
    decidedBy: 'rules',
    explanation: 'בדיקה',
    suggestedApprovers: [],
  };
}

function approvalFixture(): ApprovalRequest {
  return {
    approvalId: 'AP-test',
    jobId: null,
    envelopeId: null,
    actionClass: 'purchase.place',
    summary: 'בדיקה',
    detail: 'בדיקה',
    diffVsNorm: null,
    risk: riskFixture(),
    proposedTool: 'mail.send',
    proposedInput: null,
    inputHash: 'test-hash',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'pending',
    editedInput: null,
  };
}

describe('buildRuntime', () => {
  it('registers a mail adapter under the configured system name', async () => {
    const runtime = await buildRuntime(FULL);
    expect(runtime.registry.get('office-mail')).not.toBeNull();
    // `FULL` configures mail/notify fully but carries no GREEN_API refs at
    // all — the one warning this installation is left with is the WhatsApp
    // switch being off, not a mail-side defect. See the `GREEN_API` test
    // block below for that switch on its own.
    expect(runtime.warnings).toEqual([
      "no WhatsApp gateway: GREEN_API_INSTANCE_REF, GREEN_API_TOKEN_REF not set — the owner's WhatsApp channel will not run; messages will neither be received nor sent",
    ]);
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

  it('warns and runs without mail when the notify ref is missing, rather than throwing', async () => {
    const { NOTIFY_CREDENTIAL_REF: _ref, ...withoutRef } = FULL;
    // The scheduler still has to expire approvals — this was already the
    // shape for a missing SMTP variable, and an unset ref is the same class.
    const runtime = await buildRuntime(withoutRef);
    expect(runtime.notify).toBeUndefined();
    expect(runtime.warnings.join(' ')).toMatch(/NOTIFY_CREDENTIAL_REF/);
    // Unrelated to the mail adapter itself, same as the ANTHROPIC_API_KEY case.
    expect(runtime.registry.get('office-mail')).not.toBeNull();
  });

  it('rejects a notify ref that is not a legal credential ref', async () => {
    // CREDENTIAL_REF_PATTERN is uppercase, digits and underscore only, and
    // `key-check` / `key-recovery` are lowercase-with-hyphen precisely so a
    // real ref can never collide with them. A misconfigured ref must be
    // refused at startup, not at the first approval. Matched against the
    // message naming the control, not `toThrow()` bare — an unrelated throw
    // (a stray typo elsewhere in the same build) would otherwise pass this
    // just as well.
    await expect(
      buildRuntime({ ...FULL, NOTIFY_CREDENTIAL_REF: 'key-check' }),
    ).rejects.toThrow(/NOTIFY_CREDENTIAL_REF/);
  });

  /**
   * `JSON.stringify(runtime)` can never see `SMTP_PASS`, whatever the code
   * does: `createSmtpTransport` returns a closure with `config` captured
   * (nothing serialisable), and `AdapterRegistry` holds adapters in private
   * `Map`s that serialise to `{}`. A runtime-object probe here is vacuous by
   * construction — this project already treats that as a control-design bug
   * and reads source as text instead when the property is "this string must
   * not appear in production code" (`erasure-invariants.test.ts`'s import
   * scan, `conductor-invariants.test.ts`'s call-block scan). Put the literal
   * back anywhere non-test under `src/` and this goes red.
   */
  it('reads no SMTP_PASS anywhere in production source', async () => {
    const offenders: string[] = [];
    const scanned: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      // No `catch { return }` here. The version that had one turned a moved
      // `src/`, a renamed directory or a different cwd into permanent green on
      // zero files read — "סריקה ריקה שעוברת אינה בקרה" (CLAUDE.md), the same
      // defect `reading-invariants.test.ts` fixed by asserting it found files
      // before asserting anything about them. A `readdir` that fails is a
      // broken control, so it fails the test.
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        scanned.push(path);
        const source = await readFile(path, 'utf8');
        if (source.includes('SMTP_PASS')) offenders.push(path);
      }
    };

    await walk('src');
    // The positive half, and a floor rather than an exact count so ordinary
    // growth does not break it: this tree holds several hundred non-test
    // modules, so anything near zero means the walk did not run, not that the
    // string is absent.
    expect(scanned.length).toBeGreaterThan(100);
    expect(scanned).toContain(join('src', 'orchestrator', 'runtime.ts'));
    expect(offenders).toEqual([]);
  });

  /**
   * The wiring in `buildRuntime` (ref, credential source, business id) is
   * unmeasured by every test above it: none of them ever calls the notifier
   * it builds. Driving it end to end is what actually proves three things at
   * once — the ref resolved is the *configured* one and not some other ref
   * that happens to also be stored, the source resolving it is the real
   * encrypted store rather than a stub, and the resolved value actually
   * reaches the transport's authentication. `overrides.createTransport` is
   * `buildRuntime`'s own injection seam for exactly this, mirroring
   * `SmtpConfig.createTransport` one layer down.
   */
  it('notifies using the configured NOTIFY_CREDENTIAL_REF resolved from the real store, not a different stored ref', async () => {
    await putSecret(
      {
        businessId: config.businessId,
        ref: 'NOTIFY_MAIL',
        value: 'סוד-הנוטיפייר',
        updatedBy: 'operator@example.com',
      },
      KEY,
    );
    await putSecret(
      {
        businessId: config.businessId,
        ref: 'DECOY_REF',
        value: 'סוד-אחר-לגמרי',
        updatedBy: 'operator@example.com',
      },
      KEY,
    );

    const captured: Array<{ user?: string; pass?: string }> = [];
    const runtime = await buildRuntime(FULL, {
      createTransport: (opts) => {
        captured.push(opts.auth);
        return { sendMail: () => Promise.resolve({ messageId: 'stub-message-id' }) };
      },
    });

    const notify = runtime.notify;
    expect(notify).toBeDefined();
    if (notify === undefined) throw new Error('unreachable — asserted above');

    const result = await notify.notifier.notify(
      approvalFixture(),
      'http://127.0.0.1:8787/a/AP-test',
    );
    // Positive half first: the send genuinely went through and reached the
    // (fake) transport, so the pass value below did not come from nowhere.
    expect(result.ok).toBe(true);
    expect(captured[0]?.pass).toBe('סוד-הנוטיפייר');
    expect(captured[0]?.pass).not.toBe('סוד-אחר-לגמרי');
  });

  /**
   * Fix round 1, F3 — `sendAlert`'s own ~30 production lines (the credential
   * resolve, the `null`-credential branch, the `transport.send` call, both
   * deadline races) had no test at all; every caller in the suite used a
   * hand-built double. Mirrors the notifier test just above, through the
   * real encrypted store and the real `transport.send` call shape.
   */
  it('sendAlert resolves NOTIFY_CREDENTIAL_REF through the real store and reaches the transport', async () => {
    await putSecret(
      {
        businessId: config.businessId,
        ref: 'NOTIFY_MAIL',
        value: 'סוד-התראת-הבריאות',
        updatedBy: 'operator@example.com',
      },
      KEY,
    );

    const captured: Array<{ to: string; subject: string; text: string; auth?: { user?: string; pass?: string } }> = [];
    const runtime = await buildRuntime(FULL, {
      createTransport: (opts) => ({
        // The body arrives as a stream (see `send` in `src/mail/transport.ts`);
        // drained here so the assertion below still reads the text itself.
        sendMail: async (mail: { to: string; subject: string; text: NodeJS.ReadableStream }) => {
          let text = '';
          for await (const chunk of mail.text) text += String(chunk);
          captured.push({ to: mail.to, subject: mail.subject, text, auth: opts.auth });
          return { messageId: 'stub-message-id' };
        },
      }),
    });

    const notify = runtime.notify;
    expect(notify).toBeDefined();
    if (notify === undefined) throw new Error('unreachable — asserted above');
    expect(notify.sendAlert).toBeDefined();
    if (notify.sendAlert === undefined) throw new Error('unreachable — asserted above');

    const result = await notify.sendAlert('נושא ההתראה', 'גוף ההתראה');
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.subject).toBe('נושא ההתראה');
    expect(captured[0]?.text).toBe('גוף ההתראה');
    expect(captured[0]?.to).toBe(FULL['APPROVAL_NOTIFY_TO']);
    expect(captured[0]?.auth?.pass).toBe('סוד-התראת-הבריאות');
  });

  /**
   * Fix round 1, F3's second half — the property this whole task's design
   * leans on (resolve fresh per call, never cache across the closure's
   * lifetime) is asserted by nothing today; a refactor that hoisted the
   * `resolve` above the closure would break it with every other test still
   * green. Two calls, the stored secret ROTATED in between, the second call
   * must carry the new value.
   */
  it('sendAlert resolves a fresh credential on every call, so a rotation takes effect on the next alert', async () => {
    await putSecret(
      { businessId: config.businessId, ref: 'NOTIFY_MAIL', value: 'סוד-ראשון', updatedBy: 'operator@example.com' },
      KEY,
    );
    const captured: Array<{ pass?: string }> = [];
    const runtime = await buildRuntime(FULL, {
      createTransport: (opts) => ({
        sendMail: () => {
          captured.push({ pass: opts.auth.pass });
          return Promise.resolve({ messageId: 'stub-message-id' });
        },
      }),
    });
    const notify = runtime.notify;
    if (notify?.sendAlert === undefined) throw new Error('unreachable — asserted above');

    const first = await notify.sendAlert('נושא', 'גוף');
    expect(first.ok).toBe(true);
    expect(captured[0]?.pass).toBe('סוד-ראשון');

    await putSecret(
      { businessId: config.businessId, ref: 'NOTIFY_MAIL', value: 'סוד-שני', updatedBy: 'operator@example.com' },
      KEY,
    );
    const second = await notify.sendAlert('נושא', 'גוף');
    expect(second.ok).toBe(true);
    expect(captured[1]?.pass).toBe('סוד-שני');
    expect(captured[1]?.pass).not.toBe(captured[0]?.pass);
  });

  /**
   * `SMTP_SECURE=false` is the shipped default and the runbook's value, so the
   * mandatory-STARTTLS path is the one every installation takes. The switch
   * that turns it off exists for a local relay that speaks no TLS at all
   * (`maildev`), and it must be impossible to be in that state quietly — the
   * whole point of this branch is that one password stops travelling in the
   * clear.
   */
  it('requires STARTTLS by default, and says so loudly when told not to', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const capture = (opts: unknown): { sendMail: () => Promise<{ messageId: string }> } => {
      seen.push(opts as Record<string, unknown>);
      return { sendMail: () => Promise.resolve({ messageId: 'stub-message-id' }) };
    };

    await putSecret(
      { businessId: config.businessId, ref: 'NOTIFY_MAIL', value: 'pw', updatedBy: 'test' },
      KEY,
    );

    const strict = await buildRuntime(FULL, { createTransport: capture });
    expect(strict.warnings.join(' ')).not.toMatch(/SMTP_ALLOW_CLEARTEXT/);
    // Positive half: an option object was actually built, so the assertion
    // about its `requireTLS` is about a real send and not about nothing.
    await strict.notify?.notifier.notify(approvalFixture(), 'http://127.0.0.1:8787/a/AP-test');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.['requireTLS']).toBe(true);

    seen.length = 0;
    const lax = await buildRuntime({ ...FULL, SMTP_ALLOW_CLEARTEXT: '1' }, { createTransport: capture });
    expect(lax.warnings.join(' ')).toMatch(/SMTP_ALLOW_CLEARTEXT/);
    await lax.notify?.notifier.notify(approvalFixture(), 'http://127.0.0.1:8787/a/AP-test');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.['requireTLS']).toBe(false);

    // A value that is not exactly `1` is not the opt-out: same positive-check
    // discipline as `SMTP_SECURE === 'true'` one field over, so a typo can
    // only ever leave the stricter setting in place.
    seen.length = 0;
    const typo = await buildRuntime({ ...FULL, SMTP_ALLOW_CLEARTEXT: 'true' }, { createTransport: capture });
    expect(typo.warnings.join(' ')).not.toMatch(/SMTP_ALLOW_CLEARTEXT/);
    await typo.notify?.notifier.notify(approvalFixture(), 'http://127.0.0.1:8787/a/AP-test');
    expect(seen[0]?.['requireTLS']).toBe(true);
  });

  it('warns when ANTHROPIC_API_KEY is absent, so curation-off does not look like nothing-to-remember', async () => {
    const { ANTHROPIC_API_KEY: _key, ...withoutKey } = FULL;
    const runtime = await buildRuntime(withoutKey);
    expect(runtime.warnings.join(' ')).toMatch(/ANTHROPIC_API_KEY/);
    // Unrelated to the mail adapter — a missing model key must not also
    // suppress the mail warning path or vice versa.
    expect(runtime.registry.get('office-mail')).not.toBeNull();
  });

  /**
   * The switch, and the same pattern as `DOCUMENT_INBOX` and the five SMTP
   * vars: "no WhatsApp" is a real production state today (there is no
   * `createGreenApiGateway` yet), and it must be REPORTED, not look
   * identical to "there was nothing to send". `FULL` carries neither
   * `GREEN_API_INSTANCE_REF` nor `GREEN_API_TOKEN_REF`.
   */
  it('builds no WhatsApp gateway and warns, naming both missing GREEN-API refs', async () => {
    const runtime = await buildRuntime(FULL);
    expect(runtime.whatsapp).toBeUndefined();
    expect(runtime.warnings.join(' ')).toContain('GREEN_API_INSTANCE_REF');
    expect(runtime.warnings.join(' ')).toContain('GREEN_API_TOKEN_REF');
  });

  it('warns naming only the one GREEN-API ref that is missing', async () => {
    const runtime = await buildRuntime({ ...FULL, GREEN_API_INSTANCE_REF: 'GREEN_API_INSTANCE' });
    expect(runtime.whatsapp).toBeUndefined();
    expect(runtime.warnings.join(' ')).toContain('GREEN_API_TOKEN_REF');
    expect(runtime.warnings.join(' ')).not.toContain('GREEN_API_INSTANCE_REF not set');
  });

  it('warns when both GREEN-API refs are set but neither resolves to a stored credential', async () => {
    const runtime = await buildRuntime({
      ...FULL,
      GREEN_API_INSTANCE_REF: 'GREEN_API_INSTANCE',
      GREEN_API_TOKEN_REF: 'GREEN_API_TOKEN',
    });
    expect(runtime.whatsapp).toBeUndefined();
    expect(runtime.warnings.join(' ')).toMatch(/GREEN_API_INSTANCE_REF.*did not resolve/);
    expect(runtime.warnings.join(' ')).toMatch(/GREEN_API_TOKEN_REF.*did not resolve/);
  });

  it('rejects a GREEN-API ref that is not a legal credential ref', async () => {
    await expect(
      buildRuntime({ ...FULL, GREEN_API_INSTANCE_REF: 'key-check', GREEN_API_TOKEN_REF: 'GREEN_API_TOKEN' }),
    ).rejects.toThrow(/GREEN_API_INSTANCE_REF/);
  });

  /**
   * Both refs resolve, but no `overrides.whatsappGateway` factory is
   * supplied — the true production default today, because no
   * `createGreenApiGateway` exists yet (a later task supplies it; see
   * `buildRuntime`'s own docblock). The credentials resolving is real
   * progress over the unconfigured case above, and the warning says so.
   */
  it('warns that no gateway implementation is wired in yet, once both refs resolve', async () => {
    await putSecret(
      { businessId: config.businessId, ref: 'GREEN_API_INSTANCE', value: 'inst-1', updatedBy: 'operator@example.com' },
      KEY,
    );
    await putSecret(
      { businessId: config.businessId, ref: 'GREEN_API_TOKEN', value: 'tok-1', updatedBy: 'operator@example.com' },
      KEY,
    );
    const runtime = await buildRuntime({
      ...FULL,
      GREEN_API_INSTANCE_REF: 'GREEN_API_INSTANCE',
      GREEN_API_TOKEN_REF: 'GREEN_API_TOKEN',
    });
    expect(runtime.whatsapp).toBeUndefined();
    expect(runtime.warnings.join(' ')).toMatch(/no gateway implementation is wired in yet/);
  });

  /**
   * Half-resolved is not configured. A factory IS supplied here (unlike the
   * test above, which has none to call) — so the only thing standing between
   * this install and a gateway built on an absent token is the `instance ===
   * null || token === null` check, not the absence of a factory. Only the
   * instance ref is actually stored.
   */
  it('builds no gateway when only one of the two GREEN-API refs resolves, even with a factory supplied', async () => {
    await putSecret(
      { businessId: config.businessId, ref: 'GREEN_API_INSTANCE', value: 'inst-half', updatedBy: 'operator@example.com' },
      KEY,
    );
    const runtime = await buildRuntime(
      {
        ...FULL,
        GREEN_API_INSTANCE_REF: 'GREEN_API_INSTANCE',
        GREEN_API_TOKEN_REF: 'GREEN_API_TOKEN', // never stored
      },
      { whatsappGateway: () => createFakeGateway() },
    );
    expect(runtime.whatsapp).toBeUndefined();
    expect(runtime.warnings.join(' ')).toMatch(/GREEN_API_TOKEN_REF.*did not resolve/);
  });

  /**
   * The positive path: both refs resolve AND a factory is supplied (the seam
   * a later task's default replaces) — `runtime.whatsapp.gateway` is built
   * from the resolved credentials, not from anything this function invented.
   */
  it('builds a WhatsApp gateway from the resolved credentials when a factory is supplied', async () => {
    await putSecret(
      { businessId: config.businessId, ref: 'GREEN_API_INSTANCE', value: 'inst-42', updatedBy: 'operator@example.com' },
      KEY,
    );
    await putSecret(
      { businessId: config.businessId, ref: 'GREEN_API_TOKEN', value: 'tok-42', updatedBy: 'operator@example.com' },
      KEY,
    );
    let seenInstance: string | null = null;
    let seenToken: string | null = null;
    const runtime = await buildRuntime(
      {
        ...FULL,
        GREEN_API_INSTANCE_REF: 'GREEN_API_INSTANCE',
        GREEN_API_TOKEN_REF: 'GREEN_API_TOKEN',
      },
      {
        whatsappGateway: ({ instance, token }) => {
          seenInstance = instance.value;
          seenToken = token.value;
          return createFakeGateway();
        },
      },
    );
    expect(runtime.whatsapp).toBeDefined();
    expect(seenInstance).toBe('inst-42');
    expect(seenToken).toBe('tok-42');
    expect(runtime.warnings.join(' ')).not.toMatch(/GREEN_API|WhatsApp/);
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
   * Registration comes from the charter's declared connection and the
   * binding's `provider` column alone — never from whether an OAuth grant
   * has actually been stored. A missing authorisation is the adapter's own
   * runtime failure (`credential_unavailable`), not a missing adapter; see
   * `runtime.ts`'s own docblock on `buildRuntime`.
   */
  it('registers the provider adapter for a declared system even with no grant stored', async () => {
    await installCharter(buildCharter({ connections: [CALENDAR_CONNECTION] }), { businessId: BUSINESS });
    await upsertBinding(
      {
        system: 'office-calendar',
        status: 'live',
        endpoint: null,
        credentialRef: 'OFFICE_CALENDAR',
        provider: 'google',
        lastOkAt: null,
        lastError: null,
      },
      { by: 'test' },
    );

    const runtime = await buildRuntime(FULL);
    expect(runtime.registry.get('office-calendar')).not.toBeNull();
    // `.resolve(...)`, not only `.get(...)` (fix-round 1, finding M3): this
    // is what actually proves the registered adapter serves the RIGHT
    // channel and tool, not merely that something got registered under the
    // system name. This is also the assertion that would have caught I1 —
    // a registration keyed on `provider`/`channel` alone, with no `serves`
    // check, still returns non-null from `.get`, but a `resolve` for a tool
    // the connection does not declare would not.
    expect(runtime.registry.resolve('office-calendar', 'api', 'calendar.read')).not.toBeNull();
  });

  /**
   * Fix-round 1, finding I1 — the sharpest finding of the round. Before the
   * fix, registration keyed on `provider === 'google'` and `channel: 'api'`
   * alone, never consulting the charter's own `serves` list. `office-mail`'s
   * charter connection is ALSO `channel: 'api'`, so an owner setting
   * `provider: 'google'` on the `office-mail` binding — the natural thing to
   * do when authorising Gmail through a future consent screen — collided
   * with the mail adapter already registered under that same system name:
   * `AdapterRegistry`'s constructor throws on the duplicate, so `buildRuntime`
   * itself threw and the whole scheduler refused to boot. A row a dashboard
   * writes must never be able to stop the process from starting.
   */
  it('does not collide with the mail adapter when its own binding also carries provider: "google"', async () => {
    // The charter connection matters here, not just the binding: without one
    // declared for `office-mail`, the registration loop's own
    // `connection === undefined` check already skips it, and this test would
    // pass without ever exercising the bug it is named for.
    await installCharter(
      buildCharter({
        connections: [
          {
            system: 'office-mail',
            label: 'תיבת המשרד',
            channel: 'api',
            serves: ['mail.send'],
            target: null,
            subprocessor: null,
          },
        ],
      }),
      { businessId: BUSINESS },
    );
    await upsertBinding(
      {
        system: 'office-mail',
        status: 'live',
        endpoint: null,
        credentialRef: 'OFFICE_MAIL',
        provider: 'google',
        lastOkAt: null,
        lastError: null,
      },
      { by: 'test' },
    );

    // Must not throw.
    const runtime = await buildRuntime(FULL);
    // The mail adapter is still the one serving `office-mail`, and it still
    // serves `mail.send` — nothing here silently swapped it out.
    expect(runtime.registry.resolve('office-mail', 'api', 'mail.send')).not.toBeNull();
    // And `office-mail`'s connection does not declare `calendar.read`, so no
    // calendar adapter should have been registered for it either.
    expect(runtime.registry.resolve('office-mail', 'api', 'calendar.read')).toBeNull();
  });

  /**
   * Final fix wave, item 6 (fix-round 2, finding I3) — the general case the
   * test above does not cover. There, `office-mail`'s charter connection
   * declares only `mail.send`, so the calendar loop's own `serves` check
   * already skips it before registration is ever attempted; the collision
   * guard added for I1 is never exercised. Here ONE charter connection
   * declares BOTH `mail.send` and `calendar.read` — the natural single-
   * connection modelling of Google Workspace the ruling names — so the
   * `serves` check is satisfied and the loop would try to register a second
   * adapter under a system name the mail adapter already claimed, which is
   * exactly what makes `AdapterRegistry`'s constructor throw. `buildRuntime`
   * must still not throw: a row a dashboard writes (`provider: 'google'` on
   * an existing binding) must never be able to stop the process from
   * booting, for any charter shape.
   */
  it('does not collide with the mail adapter when one charter connection serves both mail and calendar', async () => {
    await installCharter(
      buildCharter({
        connections: [
          {
            system: 'office-mail',
            label: 'תיבת המשרד',
            channel: 'api',
            serves: ['mail.send', 'calendar.read'],
            target: null,
            subprocessor: null,
          },
        ],
      }),
      { businessId: BUSINESS },
    );
    await upsertBinding(
      {
        system: 'office-mail',
        status: 'live',
        endpoint: null,
        credentialRef: 'OFFICE_MAIL',
        provider: 'google',
        lastOkAt: null,
        lastError: null,
      },
      { by: 'test' },
    );

    // Must not throw.
    const runtime = await buildRuntime(FULL);
    // The mail adapter still serves `mail.send` under `office-mail` —
    // nothing about the skipped calendar registration touched it.
    expect(runtime.registry.resolve('office-mail', 'api', 'mail.send')).not.toBeNull();
    // No SECOND adapter was registered under the same name, so the tool the
    // charter also declares for it resolves to nothing rather than to
    // whichever adapter happened to register first.
    expect(runtime.registry.resolve('office-mail', 'api', 'calendar.read')).toBeNull();
    expect(runtime.warnings.join(' ')).toMatch(/no calendar adapter for "office-mail"/);
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
