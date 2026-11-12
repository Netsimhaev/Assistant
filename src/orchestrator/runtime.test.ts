import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { config } from '../config.js';
import { closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import type { CharterConnection } from '../domain/connection.js';
import type { ApprovalRequest } from '../governance/approvals.js';
import { putSecret } from '../governance/credential-store.js';
import { KEY_BYTES, MasterKeyError, writeKeyState } from '../governance/master-key.js';
import type { RiskAssessment } from '../domain/risk.js';
import { saveRuntimeSettings } from '../tenancy/runtime-settings.js';
import type { RuntimeSettingsPatch } from '../tenancy/runtime-settings.js';
import { upsertBinding } from './bindings.js';
import { DEFAULT_CREDENTIAL_ENV_PREFIX } from './credentials.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { createFakeGateway } from '../whatsapp/fake-gateway.js';
import {
  GREEN_API_INSTANCE_ID_REF,
  GREEN_API_TOKEN_REF,
  NOTIFY_SMTP_PASS_REF,
  buildServerRuntime,
  businessRuntime,
} from './runtime.js';
import type { Runtime, ServerRuntime, ServerRuntimeOverrides } from './runtime.js';

/** The key state is written under the configured business, so tests use it. */
const BUSINESS = config.businessId;
const OTHER = 'test-runtime-other';

const CALENDAR_CONNECTION: CharterConnection = {
  system: 'office-calendar',
  label: 'יומן המשרד',
  channel: 'api',
  serves: ['calendar.read'],
  target: null,
  subprocessor: null,
};

/** The server's environment: no business setting lives here any more. */
const SERVER_ENV = {
  DASHBOARD_BASE_URL: 'http://127.0.0.1:8787',
  ANTHROPIC_API_KEY: 'sk-test-key',
  DOCUMENT_SOFFICE_PATH: '/usr/bin/soffice',
  DOCUMENT_CHROMIUM_PATH: '/usr/bin/chromium',
};

/** A business whose mail and notify are fully configured (its password stored separately). */
const SETTINGS: RuntimeSettingsPatch = {
  mailSystem: 'office-mail',
  notifySmtpHost: '127.0.0.1',
  notifySmtpPort: 1025,
  notifySmtpSecure: false,
  notifySmtpFrom: 'assistant@example.com',
  notifySmtpUser: 'assistant',
  notifyTo: 'boss@example.com',
};

let DIR: string;
let KEY: Buffer;
/** `SERVER_ENV` plus the key path — what a correctly configured server looks like. */
let FULL: Record<string, string>;

beforeEach(async () => {
  await resetDatabase();
  DIR = await mkdtemp(join(tmpdir(), 'runtime-key-'));
  KEY = randomBytes(KEY_BYTES);
  const keyPath = join(DIR, 'master.key');
  await writeFile(keyPath, KEY, { mode: 0o600 });
  await writeKeyState(KEY, 'key-1');
  FULL = { ...SERVER_ENV, CREDENTIAL_KEY_PATH: keyPath };
});

afterEach(async () => {
  await rm(DIR, { recursive: true, force: true });
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

async function storeSecret(ref: string, value: string, businessId: string = BUSINESS): Promise<void> {
  await withBusiness(businessId, (bdb) => putSecret(bdb, { ref, value, updatedBy: 'operator@example.com' }, KEY));
}

async function saveSettings(patch: RuntimeSettingsPatch, businessId: string = BUSINESS): Promise<void> {
  await withBusiness(businessId, (db) => saveRuntimeSettings(db, patch));
}

async function runtimeFor(server: ServerRuntime, businessId: string = BUSINESS): Promise<Runtime> {
  return withBusiness(businessId, (db) => businessRuntime(server, db));
}

/**
 * The common case: a server from `env`, this business's settings saved (and
 * its notify password stored unless `pass` is null), then its runtime.
 */
async function build(
  options: {
    env?: Record<string, string | undefined>;
    settings?: RuntimeSettingsPatch | null;
    pass?: string | null;
    overrides?: ServerRuntimeOverrides;
  } = {},
): Promise<Runtime> {
  const server = await buildServerRuntime(options.env ?? FULL, options.overrides ?? {});
  const settings = options.settings === undefined ? SETTINGS : options.settings;
  if (settings !== null) await saveSettings(settings);
  const pass = options.pass === undefined ? 'pw' : options.pass;
  if (pass !== null) await storeSecret(NOTIFY_SMTP_PASS_REF, pass);
  return runtimeFor(server);
}

/**
 * Just enough of a `RiskAssessment`/`ApprovalRequest` for `notify()` to build
 * a message from — the values themselves are inert, only the notifier's
 * *wiring* (which ref, which store, does it reach the transport) is under
 * test here. Deliberately not routed through `enqueueApproval`: this file is
 * not re-testing the approval pipeline, only what `businessRuntime` hands
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

describe('businessRuntime — settings from the database', () => {
  it('a business with no settings row has no notify, no WhatsApp, no inbox, and says so in warnings', async () => {
    const runtime = await build({ env: { ...FULL, DOCUMENT_INBOX_ROOT: '/srv/inbox' }, settings: null, pass: null });
    expect(runtime.notify).toBeUndefined();
    expect(runtime.whatsapp).toBeUndefined();
    expect(runtime.inbox).toBeUndefined();
    expect(runtime.registry.get('office-mail')).toBeNull();
    const warnings = runtime.warnings.join(' | ');
    expect(warnings).toMatch(/no mail adapter: notify_smtp_host/);
    expect(warnings).toMatch(/no WhatsApp gateway: whatsapp_enabled is off/);
    expect(warnings).toMatch(/no document inbox: inbox_enabled is off/);
  });

  it('settings change takes effect on the next businessRuntime call without restart', async () => {
    const server = await buildServerRuntime(FULL);
    await storeSecret(NOTIFY_SMTP_PASS_REF, 'pw');

    const before = await runtimeFor(server);
    expect(before.notify).toBeUndefined();

    await saveSettings(SETTINGS);
    // The SAME server object — no process restart, no second key load.
    const after = await runtimeFor(server);
    expect(after.notify?.notifier.channel).toBe('email');
    expect(after.registry.get('office-mail')).not.toBeNull();

    await saveSettings({ notifyTo: null });
    const cleared = await runtimeFor(server);
    expect(cleared.notify).toBeUndefined();
    expect(cleared.warnings.join(' ')).toMatch(/notify_to not set/);
  });

  it('two businesses get their own notify recipients', async () => {
    await saveSettings({ ...SETTINGS, notifyTo: 'owner-a@example.com' }, BUSINESS);
    await saveSettings({ ...SETTINGS, notifyTo: 'owner-b@example.com' }, OTHER);
    await storeSecret(NOTIFY_SMTP_PASS_REF, 'pass-a', BUSINESS);
    await storeSecret(NOTIFY_SMTP_PASS_REF, 'pass-b', OTHER);

    const sent: Array<{ to: string; pass?: string }> = [];
    const capture: ServerRuntimeOverrides['createTransport'] = (opts) => ({
      sendMail: (mail: { to: string }) => {
        sent.push({ to: mail.to, pass: opts.auth.pass });
        return Promise.resolve({ messageId: 'stub-message-id' });
      },
    });
    // One server for both — only the settings rows and the stored passwords differ.
    const capturing = await buildServerRuntime(FULL, { createTransport: capture });

    const a = await runtimeFor(capturing, BUSINESS);
    const b = await runtimeFor(capturing, OTHER);
    expect((await a.notify?.sendAlert?.('נושא', 'גוף'))?.ok).toBe(true);
    expect((await b.notify?.sendAlert?.('נושא', 'גוף'))?.ok).toBe(true);
    expect(sent).toEqual([
      { to: 'owner-a@example.com', pass: 'pass-a' },
      { to: 'owner-b@example.com', pass: 'pass-b' },
    ]);
  });

  it('a credential source that throws fails the build loudly, never reads as "not configured"', async () => {
    await saveSettings({ whatsappEnabled: true });
    const server = await buildServerRuntime(FULL);
    const broken: ServerRuntime = {
      ...server,
      credentials: {
        resolve: async () => {
          throw new Error('credential store unreachable');
        },
      },
    };
    await expect(runtimeFor(broken)).rejects.toThrow(/credential store unreachable/);
  });

  it('builds the inbox only when the business turned it on and the server has a folder', async () => {
    const on = await build({ env: { ...FULL, DOCUMENT_INBOX_ROOT: '/srv/inbox' }, settings: { inboxEnabled: true } });
    expect(on.inbox).toBe(join('/srv/inbox', BUSINESS));
    expect(on.warnings.join(' ')).not.toMatch(/no document inbox/);

    const noFolder = await build({ settings: { inboxEnabled: true } });
    expect(noFolder.inbox).toBeUndefined();
    expect(noFolder.warnings.join(' ')).toMatch(/inbox_enabled is on, but DOCUMENT_INBOX_ROOT is not set/);
  });

  it("inbox scans only the business's own subfolder, and none when inbox is disabled", async () => {
    // One server root for both; each business's runtime names its OWN folder
    // under it, never the root and never the other's.
    const server = await buildServerRuntime({ ...FULL, DOCUMENT_INBOX_ROOT: '/srv/inbox' });
    await saveSettings({ inboxEnabled: true }, BUSINESS);
    await saveSettings({ inboxEnabled: true }, OTHER);
    expect((await runtimeFor(server, BUSINESS)).inbox).toBe(join('/srv/inbox', BUSINESS));
    expect((await runtimeFor(server, OTHER)).inbox).toBe(join('/srv/inbox', OTHER));

    // Disabled: no folder at all, even though the server has a root.
    await saveSettings({ inboxEnabled: false }, OTHER);
    const off = await runtimeFor(server, OTHER);
    expect(off.inbox).toBeUndefined();
    expect(off.warnings.join(' ')).toMatch(/inbox_enabled is off/);
  });
});

describe('buildServerRuntime + businessRuntime', () => {
  it('registers a mail adapter under the configured system name', async () => {
    const runtime = await build();
    expect(runtime.registry.get('office-mail')).not.toBeNull();
    // `SETTINGS` configures mail/notify fully but turns neither WhatsApp nor
    // the inbox on — the two warnings this business is left with are those
    // switches being off, not a mail-side defect. See the WhatsApp block
    // below for that switch on its own.
    expect(runtime.warnings).toEqual([
      "no WhatsApp gateway: whatsapp_enabled is off for this business — the owner's WhatsApp channel will not run; messages will neither be received nor sent",
      'no document inbox: inbox_enabled is off for this business',
    ]);
  });

  it('builds a notifier when a destination and SMTP are both configured', async () => {
    const runtime = await build();
    expect(runtime.notify?.notifier.channel).toBe('email');
    expect(runtime.notify?.dashboardBaseUrl).toBe('http://127.0.0.1:8787');
  });

  it('warns loudly rather than silently omitting the mail adapter', async () => {
    const runtime = await build({ settings: { ...SETTINGS, notifySmtpHost: null } });
    expect(runtime.registry.get('office-mail')).toBeNull();
    expect(runtime.warnings.join(' ')).toMatch(/notify_smtp_host/);
  });

  it('warns when SMTP is configured but nobody is set to receive notifications', async () => {
    const runtime = await build({ settings: { ...SETTINGS, notifyTo: null } });
    expect(runtime.notify).toBeUndefined();
    expect(runtime.warnings.join(' ')).toMatch(/notify_to/);
  });

  it('warns and runs without notify when the notify password is not stored, rather than throwing', async () => {
    // The scheduler still has to expire approvals — this was already the
    // shape for a missing SMTP setting, and an unstored password is the same class.
    const runtime = await build({ pass: null });
    expect(runtime.notify).toBeUndefined();
    expect(runtime.warnings.join(' ')).toMatch(/NOTIFY_SMTP_PASS is not stored/);
    // Unrelated to the mail adapter itself, same as the ANTHROPIC_API_KEY case.
    expect(runtime.registry.get('office-mail')).not.toBeNull();
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
   * back anywhere non-test under `src/` and this goes red. The fixed secret
   * NAME `NOTIFY_SMTP_PASS` (a ref in the business's encrypted store, never an
   * env var) is the one spelling that is allowed, and only that one.
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
        if (/(?<!NOTIFY_)SMTP_PASS/.test(source)) offenders.push(path);
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
    // And the pattern itself bites on the old spelling while sparing the new.
    expect(/(?<!NOTIFY_)SMTP_PASS/.test("env['SMTP_PASS']")).toBe(true);
    expect(/(?<!NOTIFY_)SMTP_PASS/.test("'NOTIFY_SMTP_PASS'")).toBe(false);
  });

  /**
   * The wiring (ref, credential source, business id) is unmeasured by every
   * test above it: none of them ever calls the notifier it builds. Driving it
   * end to end is what actually proves three things at once — the ref
   * resolved is the fixed `NOTIFY_SMTP_PASS` and not some other ref that
   * happens to also be stored, the source resolving it is the real encrypted
   * store rather than a stub, and the resolved value actually reaches the
   * transport's authentication. `overrides.createTransport` is the server
   * runtime's own injection seam for exactly this, mirroring
   * `SmtpConfig.createTransport` one layer down.
   */
  it('notifies using NOTIFY_SMTP_PASS resolved from the real store, not a different stored ref', async () => {
    await storeSecret('DECOY_REF', 'סוד-אחר-לגמרי');

    const captured: Array<{ user?: string; pass?: string }> = [];
    const runtime = await build({
      pass: 'סוד-הנוטיפייר',
      overrides: {
        createTransport: (opts) => {
          captured.push(opts.auth);
          return { sendMail: () => Promise.resolve({ messageId: 'stub-message-id' }) };
        },
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
  it('sendAlert resolves NOTIFY_SMTP_PASS through the real store and reaches the transport', async () => {
    const captured: Array<{ to: string; subject: string; text: string; auth?: { user?: string; pass?: string } }> = [];
    const runtime = await build({
      pass: 'סוד-התראת-הבריאות',
      overrides: {
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
      },
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
    expect(captured[0]?.to).toBe(SETTINGS.notifyTo);
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
    const captured: Array<{ pass?: string }> = [];
    const runtime = await build({
      pass: 'סוד-ראשון',
      overrides: {
        createTransport: (opts) => ({
          sendMail: () => {
            captured.push({ pass: opts.auth.pass });
            return Promise.resolve({ messageId: 'stub-message-id' });
          },
        }),
      },
    });
    const notify = runtime.notify;
    if (notify?.sendAlert === undefined) throw new Error('unreachable — asserted above');

    const first = await notify.sendAlert('נושא', 'גוף');
    expect(first.ok).toBe(true);
    expect(captured[0]?.pass).toBe('סוד-ראשון');

    await storeSecret(NOTIFY_SMTP_PASS_REF, 'סוד-שני');
    const second = await notify.sendAlert('נושא', 'גוף');
    expect(second.ok).toBe(true);
    expect(captured[1]?.pass).toBe('סוד-שני');
    expect(captured[1]?.pass).not.toBe(captured[0]?.pass);
  });

  /**
   * `notify_smtp_secure = false` is the shipped default and the runbook's
   * value, so the mandatory-STARTTLS path is the one every business takes.
   * The switch that turns it off exists for a local relay that speaks no TLS
   * at all (`maildev`), and it must be impossible to be in that state quietly
   * — the whole point of this branch is that one password stops travelling
   * in the clear.
   */
  it('requires STARTTLS by default, and says so loudly when told not to', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const capture = (opts: unknown): { sendMail: () => Promise<{ messageId: string }> } => {
      seen.push(opts as Record<string, unknown>);
      return { sendMail: () => Promise.resolve({ messageId: 'stub-message-id' }) };
    };

    const strict = await build({ overrides: { createTransport: capture } });
    expect(strict.warnings.join(' ')).not.toMatch(/allow_cleartext/);
    // Positive half: an option object was actually built, so the assertion
    // about its `requireTLS` is about a real send and not about nothing.
    await strict.notify?.notifier.notify(approvalFixture(), 'http://127.0.0.1:8787/a/AP-test');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.['requireTLS']).toBe(true);

    seen.length = 0;
    const lax = await build({
      settings: { ...SETTINGS, notifySmtpAllowCleartext: true },
      overrides: { createTransport: capture },
    });
    expect(lax.warnings.join(' ')).toMatch(/notify_smtp_allow_cleartext/);
    await lax.notify?.notifier.notify(approvalFixture(), 'http://127.0.0.1:8787/a/AP-test');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.['requireTLS']).toBe(false);
  });

  it('marks document production available when both binary paths are set', async () => {
    const server = await buildServerRuntime(FULL);
    const runtime = await runtimeFor(server);
    expect(runtime.production).toEqual({
      available: true,
      sofficePath: '/usr/bin/soffice',
      chromiumPath: '/usr/bin/chromium',
    });
    expect(server.warnings.join(' ')).not.toMatch(/DOCUMENT_SOFFICE_PATH|DOCUMENT_CHROMIUM_PATH/);
  });

  it('warns, and does not throw, when the LibreOffice or Chromium path is absent', async () => {
    const { DOCUMENT_SOFFICE_PATH: _s, ...withoutSoffice } = FULL;
    const noSoffice = await buildServerRuntime(withoutSoffice);
    expect(noSoffice.production.available).toBe(false);
    expect(noSoffice.warnings.join(' ')).toMatch(/no document production: DOCUMENT_SOFFICE_PATH not set/);
    expect(noSoffice.warnings.join(' ')).not.toMatch(/DOCUMENT_CHROMIUM_PATH/);

    // Absent and explicitly empty are both "not set".
    const withoutBoth: Record<string, string> = { ...FULL, DOCUMENT_SOFFICE_PATH: '' };
    delete withoutBoth['DOCUMENT_CHROMIUM_PATH'];
    const neither = await buildServerRuntime(withoutBoth);
    expect(neither.production).toEqual({ available: false, sofficePath: null, chromiumPath: null });
    expect(neither.warnings.join(' ')).toMatch(/DOCUMENT_SOFFICE_PATH, DOCUMENT_CHROMIUM_PATH not set/);
    // Unrelated to mail: the business's runtime is still built.
    await saveSettings(SETTINGS);
    expect((await runtimeFor(neither)).registry.get('office-mail')).not.toBeNull();
  });

  it('warns when ANTHROPIC_API_KEY is absent, so curation-off does not look like nothing-to-remember', async () => {
    const { ANTHROPIC_API_KEY: _key, ...withoutKey } = FULL;
    const server = await buildServerRuntime(withoutKey);
    expect(server.warnings.join(' ')).toMatch(/ANTHROPIC_API_KEY/);
    // Unrelated to the mail adapter — a missing model key must not also
    // suppress the mail warning path or vice versa.
    await saveSettings(SETTINGS);
    expect((await runtimeFor(server)).registry.get('office-mail')).not.toBeNull();
  });

  /**
   * The switch, and the same pattern as the inbox and the SMTP settings: "no
   * WhatsApp" is a real production state today (there is no
   * `createGreenApiGateway` yet), and it must be REPORTED, not look
   * identical to "there was nothing to send".
   */
  it('builds no WhatsApp gateway and warns when the business has not turned it on', async () => {
    const runtime = await build();
    expect(runtime.whatsapp).toBeUndefined();
    expect(runtime.warnings.join(' ')).toMatch(/whatsapp_enabled is off/);
  });

  it('warns when WhatsApp is on but neither GREEN-API secret is stored', async () => {
    const runtime = await build({ settings: { ...SETTINGS, whatsappEnabled: true } });
    expect(runtime.whatsapp).toBeUndefined();
    expect(runtime.warnings.join(' ')).toMatch(/GREEN_API_INSTANCE_ID.*did not resolve/);
    expect(runtime.warnings.join(' ')).toMatch(/GREEN_API_TOKEN.*did not resolve/);
  });

  /**
   * Both secrets resolve, but no `overrides.whatsappGateway` factory is
   * supplied — the true production default today, because no
   * `createGreenApiGateway` exists yet (a later task supplies it; see
   * `businessRuntime`'s own docblock). The credentials resolving is real
   * progress over the unconfigured case above, and the warning says so.
   */
  it('warns that no gateway implementation is wired in yet, once both secrets resolve', async () => {
    await storeSecret(GREEN_API_INSTANCE_ID_REF, 'inst-1');
    await storeSecret(GREEN_API_TOKEN_REF, 'tok-1');
    const runtime = await build({ settings: { ...SETTINGS, whatsappEnabled: true } });
    expect(runtime.whatsapp).toBeUndefined();
    expect(runtime.warnings.join(' ')).toMatch(/no gateway implementation is wired in yet/);
  });

  /**
   * Half-resolved is not configured. A factory IS supplied here (unlike the
   * test above, which has none to call) — so the only thing standing between
   * this business and a gateway built on an absent token is the `instance ===
   * null || token === null` check, not the absence of a factory. Only the
   * instance secret is actually stored.
   */
  it('builds no gateway when only one of the two GREEN-API secrets resolves, even with a factory supplied', async () => {
    await storeSecret(GREEN_API_INSTANCE_ID_REF, 'inst-half');
    const runtime = await build({
      settings: { ...SETTINGS, whatsappEnabled: true },
      overrides: { whatsappGateway: () => createFakeGateway() },
    });
    expect(runtime.whatsapp).toBeUndefined();
    expect(runtime.warnings.join(' ')).toMatch(/GREEN_API_TOKEN did not resolve/);
    expect(runtime.warnings.join(' ')).not.toMatch(/GREEN_API_INSTANCE_ID/);
  });

  /**
   * The positive path: both secrets resolve AND a factory is supplied (the
   * seam a later task's default replaces) — `runtime.whatsapp.gateway` is
   * built from the resolved credentials, not from anything this function
   * invented.
   */
  it('builds a WhatsApp gateway from the resolved credentials when a factory is supplied', async () => {
    await storeSecret(GREEN_API_INSTANCE_ID_REF, 'inst-42');
    await storeSecret(GREEN_API_TOKEN_REF, 'tok-42');
    let seenInstance: string | null = null;
    let seenToken: string | null = null;
    const runtime = await build({
      settings: { ...SETTINGS, whatsappEnabled: true },
      overrides: {
        whatsappGateway: ({ instance, token }) => {
          seenInstance = instance.value;
          seenToken = token.value;
          return createFakeGateway();
        },
      },
    });
    expect(runtime.whatsapp).toBeDefined();
    expect(seenInstance).toBe('inst-42');
    expect(seenToken).toBe('tok-42');
    expect(runtime.warnings.join(' ')).not.toMatch(/GREEN_API|WhatsApp/);
  });

  it('always supplies a credential source', async () => {
    const server = await buildServerRuntime({ CREDENTIAL_KEY_PATH: FULL['CREDENTIAL_KEY_PATH'] as string });
    const runtime = await runtimeFor(server);
    expect(typeof runtime.credentials.resolve).toBe('function');
  });

  it('treats an explicitly-empty mail system as unset, not as a literal empty system id', async () => {
    // An adapter registered under an empty system id can never be matched by
    // `resolveChannel` — every mail.send step would fail silently, with no
    // warning at all. `saveRuntimeSettings` stores empty as NULL, and NULL
    // falls back to the default.
    const runtime = await build({ settings: { ...SETTINGS, mailSystem: '' } });
    expect(runtime.registry.get('office-mail')).not.toBeNull();
  });

  it('treats an explicitly-empty DASHBOARD_BASE_URL as unset, not as a literal empty link', async () => {
    const runtime = await build({ env: { ...FULL, DASHBOARD_BASE_URL: '' } });
    expect(runtime.notify?.dashboardBaseUrl).toBe('http://127.0.0.1:8787');
  });

  it('registers the browser driver as the browser channel default', async () => {
    const runtime = await build();
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
   * `businessRuntime`'s own docblock.
   */
  it('registers the provider adapter for a declared system even with no grant stored', async () => {
    await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ connections: [CALENDAR_CONNECTION] })));
    await withBusiness(BUSINESS, (db) => upsertBinding(db, {
        system: 'office-calendar',
        status: 'live',
        endpoint: null,
        credentialRef: 'OFFICE_CALENDAR',
        provider: 'google',
        lastOkAt: null,
        lastError: null,
      }, { by: 'test' }));

    const runtime = await build();
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

  it('reads a binding written after the server runtime was built, on the next business build', async () => {
    // The restart the old single build required: a `provider` set through the
    // dashboard now takes effect on the business's next pass.
    const server = await buildServerRuntime(FULL);
    await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ connections: [CALENDAR_CONNECTION] })));
    expect((await runtimeFor(server)).registry.get('office-calendar')).toBeNull();
    await withBusiness(BUSINESS, (db) => upsertBinding(db, {
        system: 'office-calendar',
        status: 'live',
        endpoint: null,
        credentialRef: 'OFFICE_CALENDAR',
        provider: 'google',
        lastOkAt: null,
        lastError: null,
      }, { by: 'test' }));
    expect((await runtimeFor(server)).registry.get('office-calendar')).not.toBeNull();
  });

  /**
   * Fix-round 1, finding I1 — the sharpest finding of the round. Before the
   * fix, registration keyed on `provider === 'google'` and `channel: 'api'`
   * alone, never consulting the charter's own `serves` list. `office-mail`'s
   * charter connection is ALSO `channel: 'api'`, so an owner setting
   * `provider: 'google'` on the `office-mail` binding — the natural thing to
   * do when authorising Gmail through a future consent screen — collided
   * with the mail adapter already registered under that same system name:
   * `AdapterRegistry`'s constructor throws on the duplicate, so the runtime
   * build itself threw and the whole scheduler refused to boot. A row a dashboard
   * writes must never be able to stop the process from starting.
   */
  it('does not collide with the mail adapter when its own binding also carries provider: "google"', async () => {
    // The charter connection matters here, not just the binding: without one
    // declared for `office-mail`, the registration loop's own
    // `connection === undefined` check already skips it, and this test would
    // pass without ever exercising the bug it is named for.
    await withBusiness(BUSINESS, (bdb) => installCharter(
      bdb,
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
      })
    ));
    await withBusiness(BUSINESS, (db) => upsertBinding(db, {
        system: 'office-mail',
        status: 'live',
        endpoint: null,
        credentialRef: 'OFFICE_MAIL',
        provider: 'google',
        lastOkAt: null,
        lastError: null,
      }, { by: 'test' }));

    // Must not throw.
    const runtime = await build();
    // The mail adapter is still the one serving `office-mail`, and it still
    // serves `mail.send` — nothing here silently swapped it out.
    expect(runtime.registry.resolve('office-mail', 'api', 'mail.send')).not.toBeNull();
    // And `office-mail`'s connection does not declare `calendar.read`, so no
    // calendar adapter should have been registered for it either.
    expect(runtime.registry.resolve('office-mail', 'api', 'calendar.read')).toBeNull();
  });

  /**
   * Mailbox connection, Task 4: `connectionAcceptsOAuthCeremony` now accepts
   * the `mailbox` connection (it has an OAuth profile), so the calendar
   * registration loop must check `calendar.read` itself. A `mailbox` binding
   * must never receive a calendar adapter.
   */
  it('does not register a calendar adapter for a mailbox binding', async () => {
    await withBusiness(BUSINESS, (bdb) => installCharter(
      bdb,
      buildCharter({
        connections: [
          {
            system: 'mailbox',
            label: 'תיבת הדואר',
            channel: 'api',
            serves: ['mail.send'],
            target: null,
            subprocessor: null,
          },
        ],
      })
    ));
    await withBusiness(BUSINESS, (db) => upsertBinding(db, {
        system: 'mailbox',
        status: 'live',
        endpoint: null,
        credentialRef: 'OAUTH_MAILBOX',
        provider: 'google',
        lastOkAt: null,
        lastError: null,
      }, { by: 'test' }));

    const runtime = await build();
    expect(runtime.registry.resolve('mailbox', 'api', 'calendar.read')).toBeNull();
    // It gets the mailbox SEND adapter, and only that.
    expect(runtime.registry.resolve('mailbox', 'api', 'mail.send')).not.toBeNull();
  });

  it('runtime registers mailbox-send for a microsoft mailbox binding', async () => {
    await withBusiness(BUSINESS, (bdb) => installCharter(
      bdb,
      buildCharter({
        connections: [
          {
            system: 'mailbox',
            label: 'תיבת הדואר',
            channel: 'api',
            serves: ['mail.send'],
            target: null,
            subprocessor: null,
          },
        ],
      })
    ));
    await withBusiness(BUSINESS, (db) => upsertBinding(db, {
        system: 'mailbox',
        status: 'live',
        endpoint: null,
        credentialRef: 'OAUTH_MAILBOX',
        provider: 'microsoft',
        lastOkAt: null,
        lastError: null,
      }, { by: 'test' }));

    const runtime = await build();
    expect(runtime.registry.resolve('mailbox', 'api', 'mail.send')).not.toBeNull();
    expect(runtime.registry.resolve('mailbox', 'api', 'calendar.read')).toBeNull();
    // SMTP adapter still registered for notifications.
    expect(runtime.registry.resolve('office-mail', 'api', 'mail.send')).not.toBeNull();
  });

  it('registers the calendar adapter for the calendar binding only', async () => {
    await withBusiness(BUSINESS, (bdb) => installCharter(
      bdb,
      buildCharter({
        connections: [
          {
            system: 'calendar',
            label: 'יומן העסק',
            channel: 'api',
            serves: ['calendar.read', 'calendar.write'],
            target: null,
            subprocessor: 'google-workspace',
          },
          {
            system: 'office-calendar',
            label: 'יומן המשרד',
            channel: 'api',
            serves: ['calendar.read'],
            target: 'legacy-calendar',
            subprocessor: null,
          },
        ],
      })
    ));
    for (const [system, provider] of [
      ['calendar', 'google'],
      ['office-calendar', 'google'],
    ] as const) {
      await withBusiness(BUSINESS, (db) => upsertBinding(db, {
          system,
          status: 'live',
          endpoint: null,
          credentialRef: system === 'calendar' ? 'OAUTH_CALENDAR' : 'OAUTH_OFFICE_CALENDAR',
          provider,
          lastOkAt: null,
          lastError: null,
        }, { by: 'test' }));
    }

    // Must not throw: the legacy read-only adapter is NOT registered under
    // the `calendar` name next to the new one.
    const runtime = await build();
    expect(runtime.registry.resolve('calendar', 'api', 'calendar.write')).not.toBeNull();
    expect(runtime.registry.resolve('calendar', 'api', 'calendar.read')).not.toBeNull();
    expect(runtime.registry.resolve('calendar', 'api', 'mail.send')).toBeNull();
    // The legacy connection keeps its read-only adapter, unchanged.
    expect(runtime.registry.resolve('office-calendar', 'api', 'calendar.read')).not.toBeNull();
    expect(runtime.registry.resolve('office-calendar', 'api', 'calendar.write')).toBeNull();
  });

  it('does not register the calendar adapter when the binding provider is not the signed one', async () => {
    await withBusiness(BUSINESS, (bdb) => installCharter(
      bdb,
      buildCharter({
        connections: [
          {
            system: 'calendar',
            label: 'יומן העסק',
            channel: 'api',
            serves: ['calendar.read', 'calendar.write'],
            target: null,
            subprocessor: 'google-workspace',
          },
        ],
      })
    ));
    await withBusiness(BUSINESS, (db) => upsertBinding(db, {
        system: 'calendar',
        status: 'live',
        endpoint: null,
        credentialRef: 'OAUTH_CALENDAR',
        provider: 'microsoft',
        lastOkAt: null,
        lastError: null,
      }, { by: 'test' }));
    const runtime = await build();
    expect(runtime.registry.resolve('calendar', 'api', 'calendar.write')).toBeNull();
    expect(runtime.warnings.some((w) => w.includes('no calendar adapter') && w.includes('signed charter'))).toBe(true);
  });

  it('does not register the calendar adapter for a calendar binding that has no provider', async () => {
    await withBusiness(BUSINESS, (bdb) => installCharter(
      bdb,
      buildCharter({
        connections: [
          {
            system: 'calendar',
            label: 'יומן העסק',
            channel: 'api',
            serves: ['calendar.read', 'calendar.write'],
            target: null,
            subprocessor: 'google-workspace',
          },
        ],
      })
    ));
    await withBusiness(BUSINESS, (db) => upsertBinding(db, {
        system: 'calendar',
        status: 'live',
        endpoint: null,
        credentialRef: 'OAUTH_CALENDAR',
        provider: null,
        lastOkAt: null,
        lastError: null,
      }, { by: 'test' }));
    const runtime = await build();
    expect(runtime.registry.resolve('calendar', 'api', 'calendar.write')).toBeNull();
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
   * exactly what makes `AdapterRegistry`'s constructor throw. The runtime
   * build must still not throw: a row a dashboard writes (`provider: 'google'` on
   * an existing binding) must never be able to stop the process from
   * booting, for any charter shape.
   */
  it('does not collide with the mail adapter when one charter connection serves both mail and calendar', async () => {
    await withBusiness(BUSINESS, (bdb) => installCharter(
      bdb,
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
      })
    ));
    await withBusiness(BUSINESS, (db) => upsertBinding(db, {
        system: 'office-mail',
        status: 'live',
        endpoint: null,
        credentialRef: 'OFFICE_MAIL',
        provider: 'google',
        lastOkAt: null,
        lastError: null,
      }, { by: 'test' }));

    // Must not throw.
    const runtime = await build();
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
    await storeSecret('OFFICE_MAIL', 'sealed-in-the-database');

    const runtime = await build({
      env: {
        ...FULL,
        // Exactly the shape `envCredentials` reads. Stored nowhere else.
        [`${DEFAULT_CREDENTIAL_ENV_PREFIX}DECOY`]: 'from-the-environment',
      },
    });

    const stored = await runtime.credentials.resolve('OFFICE_MAIL', BUSINESS);
    expect(stored?.value).toBe('sealed-in-the-database');
    expect(await runtime.credentials.resolve('DECOY', BUSINESS)).toBeNull();
  });

  /**
   * Spec §4.2 — an install with no key does not start. The alternative is an
   * install that runs and fails one customer at a time, in a way that looks
   * like network trouble.
   */
  it('refuses to build at all when no key file is configured', async () => {
    const { CREDENTIAL_KEY_PATH: _path, ...withoutKeyPath } = FULL;
    await expect(buildServerRuntime(withoutKeyPath)).rejects.toThrow(MasterKeyError);
    await expect(buildServerRuntime({ ...FULL, CREDENTIAL_KEY_PATH: '' })).rejects.toThrow(
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
      buildServerRuntime({ ...FULL, CREDENTIAL_KEY_PATH: wrongPath }),
    ).rejects.toThrow(MasterKeyError);
    // …and the right one still builds, so the refusal above is the key and
    // not something that makes every build fail.
    await expect(buildServerRuntime(FULL)).resolves.toBeDefined();
  });
});
