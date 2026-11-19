/**
 * Route tests for the owner signing, changing and removing an external system
 * (Stage D, Task 10). Real HTTP server and Postgres — the harness
 * `calendar-connect.test.ts` uses.
 */
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryAudit } from '../audit/log.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
import { DENY_CODES } from '../domain/policy.js';
import { loadDrafts, saveDraft } from '../external/store.js';
import { putSecret, listSecretRefs } from '../governance/credential-store.js';
import { KEY_BYTES, writeKeyState } from '../governance/master-key.js';
import { loadBindings } from '../orchestrator/bindings.js';
import { resolveChannel } from '../orchestrator/channels.js';
import { createJob } from '../orchestrator/jobs.js';
import { loadRampLevel } from '../orchestrator/ramp.js';
import { canonicalHash } from '../util/canonical.js';
import { crmFixture } from '../test/external-fixtures.js';
import { buildCharter } from '../test/fixtures.js';
import { evaluateFor } from '../test/gate.js';
import { resetDatabase, testDb } from '../test/db.js';
import { createTestOwner, TEST_MASTER_KEY, loginWithSecondFactor } from '../test/owner.js';
import { issueCsrfToken } from './csrf.js';
import { createServer } from './server.js';
import { EXTERNAL_READD_FROM_DRAFT, EXTERNAL_READD_NEEDS_TECHNICIAN } from './external-connect.js';

const BUSINESS = 'test-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';

let server: Server | null = null;
let key: Buffer;

beforeEach(async () => {
  await resetDatabase();
  key = randomBytes(KEY_BYTES);
  await writeKeyState(key, 'KEY-test', testDb());
  await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
  await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({})));
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});
afterAll(async () => {
  await closePool();
});

async function startServer(): Promise<string> {
  server = createServer({ masterKey: TEST_MASTER_KEY, port: 0, dashboardBaseUrl: 'http://127.0.0.1:4173' });
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function login(baseUrl: string): Promise<string> {
  return loginWithSecondFactor(baseUrl, BUSINESS, { username: USERNAME, password: PASSWORD });
}

function csrfFor(cookie: string): string {
  const sessionId = cookie.split('=')[1];
  if (sessionId === undefined) throw new Error('bad cookie');
  return issueCsrfToken(sessionId);
}

async function postForm(baseUrl: string, cookie: string, path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { cookie }, body: new URLSearchParams(fields), redirect: 'manual' });
}

async function saveCrmDraft(definition: unknown = crmFixture()): Promise<void> {
  await withBusiness(BUSINESS, (db) => saveDraft(db, { systemId: 'crm', definition, staffId: 'staff-1' }));
}

async function activeVersion(): Promise<string> {
  const active = await withBusiness(BUSINESS, (db) => loadActiveCharter(db));
  if (active === null) throw new Error('no charter');
  return active.charter.charterVersion;
}

/** The hidden fields the sign page carries, read back from its HTML. */
function hiddenField(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (match?.[1] === undefined) throw new Error(`no hidden field ${name}`);
  return match[1];
}

async function signCrm(baseUrl: string, cookie: string): Promise<Response> {
  const html = await (await fetch(`${baseUrl}/connections/external/crm/sign`, { headers: { cookie } })).text();
  return postForm(baseUrl, cookie, '/connections/external/crm/sign', {
    csrf: csrfFor(cookie),
    base: hiddenField(html, 'base'),
    draftHash: hiddenField(html, 'draftHash'),
  });
}

describe('GET /connections/external', () => {
  it('lists only systems with a draft or a signed definition, and the connections page links to it', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const empty = await (await fetch(`${baseUrl}/connections/external`, { headers: { cookie } })).text();
    expect(empty).not.toContain('crm');
    expect(empty).toContain('אין מערכות חיצוניות');

    await saveCrmDraft();
    const listed = await (await fetch(`${baseUrl}/connections/external`, { headers: { cookie } })).text();
    expect(listed).toContain('מערכת הלקוחות');
    expect(listed).toContain('href="/connections/external/crm/sign"');

    const connections = await (await fetch(`${baseUrl}/connections`, { headers: { cookie } })).text();
    expect(connections).toContain('href="/connections/external"');
  });

  it('is behind the owner session', async () => {
    const baseUrl = await startServer();
    const res = await fetch(`${baseUrl}/connections/external`, { redirect: 'manual' });
    expect([302, 303]).toContain(res.status);
  });
});

describe('the sign page', () => {
  it('shows every operation, the money rule, the webhook, the scan sentence, the host and the draft hash', async () => {
    await saveCrmDraft();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/connections/external/crm/sign`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('העוזרת תוכל: רשימת לקוחות (קריאה)');
    expect(html).toContain('העוזרת תוכל: עדכון לקוח (שינוי)');
    expect(html).toContain('העוזרת תוכל: מחיקת לקוח (מחיקה)');
    expect(html).toContain('העוזרת תוכל: החזר כספי (כסף) — רק אחרי &quot;כן&quot; שלך');
    expect(html).toContain('התראות נכנסות (webhook)');
    expect(html).toContain('לקוח חדש');
    expect(html).toContain('תקרא אוטומטית');
    expect(html).toContain('כל 24 שעות, בלי לשאול אותך בכל פעם');
    expect(html).toContain('api.crm.example.com');
    expect(html).toContain('חסר סוד — הטכנאי צריך לשמור אותו');
    expect(hiddenField(html, 'draftHash')).toBe(canonicalHash(crmFixture()));
    expect(hiddenField(html, 'base')).toBe(await activeVersion());
    expect(html).not.toContain('שינוי במערכת חתומה');
  });

  it('says nothing about a missing secret once the key is stored', async () => {
    await saveCrmDraft();
    await withBusiness(BUSINESS, (db) => putSecret(db, { ref: 'EXT_CRM_KEY', value: 'k', updatedBy: 'staff' }, key));
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/connections/external/crm/sign`, { headers: { cookie } })).text();
    expect(html).not.toContain('חסר סוד');
  });

  it('strips bidi controls from labels the technician typed', async () => {
    await saveCrmDraft({ ...crmFixture(), label: 'מערכת‮ הלקוחות' });
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/connections/external/crm/sign`, { headers: { cookie } })).text();
    expect(html).not.toContain('‮');
    expect(html).toContain('מערכת הלקוחות');
  });

  it('refuses a system with no draft, and a draft that does not parse', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    expect((await fetch(`${baseUrl}/connections/external/crm/sign`, { headers: { cookie } })).status).toBe(404);
    await saveCrmDraft({ id: 'crm', label: 'x' });
    const bad = await fetch(`${baseUrl}/connections/external/crm/sign`, { headers: { cookie } });
    expect(bad.status).toBe(409);
    expect(await bad.text()).not.toContain('name="draftHash"');
  });
});

describe('POST /connections/external/:system/sign', () => {
  it('signs: the charter carries the system, the binding is live, the draft is gone, and the channel resolves', async () => {
    await saveCrmDraft();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await signCrm(baseUrl, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/connections/external');

    const active = await withBusiness(BUSINESS, (db) => loadActiveCharter(db));
    expect(active?.charter.externalSystems.map((s) => s.id)).toEqual(['crm']);
    expect(active?.charter.data.subprocessorsAllowed).toContain('ext:crm');
    const bindings = await withBusiness(BUSINESS, (db) => loadBindings(db));
    const binding = bindings.find((b) => b.system === 'ext:crm');
    expect(binding).toMatchObject({ status: 'live', credentialRef: 'EXT_CRM_KEY', endpoint: null, provider: null });
    expect(resolveChannel(active!.bundle, bindings, 'ext.call', 'crm')).toEqual({
      status: 'resolved',
      system: 'ext:crm',
      channel: 'api',
    });
    expect(await withBusiness(BUSINESS, (db) => loadDrafts(db))).toEqual([]);
    const audit = await withBusiness(BUSINESS, (db) => queryAudit(db));
    expect(audit.some((r) => r.kind === 'charter_change')).toBe(true);
    expect(audit.some((r) => r.kind === 'connection_binding')).toBe(true);
  });

  it('signing with a stale base returns 409 and installs nothing', async () => {
    await saveCrmDraft();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const before = await activeVersion();
    const res = await postForm(baseUrl, cookie, '/connections/external/crm/sign', {
      csrf: csrfFor(cookie),
      base: 'old-version',
      draftHash: canonicalHash(crmFixture()),
    });
    expect(res.status).toBe(409);
    expect(await activeVersion()).toBe(before);
    expect(await withBusiness(BUSINESS, (db) => loadBindings(db))).toEqual([]);
    expect(await withBusiness(BUSINESS, (db) => loadDrafts(db))).toHaveLength(1);
  });

  it('a draft edited between showing and posting re-renders the new preview and signs nothing', async () => {
    await saveCrmDraft();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const shown = await (await fetch(`${baseUrl}/connections/external/crm/sign`, { headers: { cookie } })).text();
    const edited = crmFixture();
    edited.operations = edited.operations.map((o) => (o.name === 'update_customer' ? { ...o, label: 'שינוי טלפון ללקוח' } : o));
    await saveCrmDraft(edited);
    const before = await activeVersion();

    const res = await postForm(baseUrl, cookie, '/connections/external/crm/sign', {
      csrf: csrfFor(cookie),
      base: hiddenField(shown, 'base'),
      draftHash: hiddenField(shown, 'draftHash'),
    });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('שינוי טלפון ללקוח');
    expect(hiddenField(html, 'draftHash')).toBe(canonicalHash(edited));
    expect(await activeVersion()).toBe(before);
    expect(await withBusiness(BUSINESS, (db) => loadBindings(db))).toEqual([]);
    expect(await withBusiness(BUSINESS, (db) => loadDrafts(db))).toHaveLength(1);
  });

  it('refuses a bad CSRF token, writing nothing', async () => {
    await saveCrmDraft();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const before = await activeVersion();
    const res = await postForm(baseUrl, cookie, '/connections/external/crm/sign', {
      csrf: 'nope', base: before, draftHash: canonicalHash(crmFixture()),
    });
    expect(res.status).toBe(403);
    expect(await activeVersion()).toBe(before);
  });

  it('a change to a signed system needs a new signature, and the page names what changed', async () => {
    await saveCrmDraft();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    expect((await signCrm(baseUrl, cookie)).status).toBe(303);

    const changed = crmFixture();
    changed.baseUrl = 'https://api.other-crm.example.net/v1';
    changed.operations = changed.operations.filter((o) => o.name !== 'delete_customer');
    await saveCrmDraft(changed);

    const status = await (await fetch(`${baseUrl}/connections/external`, { headers: { cookie } })).text();
    expect(status).toContain('טיוטת שינוי ממתינה לחתימה');

    const html = await (await fetch(`${baseUrl}/connections/external/crm/sign`, { headers: { cookie } })).text();
    expect(html).toContain('שינוי במערכת חתומה');
    expect(html).toContain('delete_customer');
    expect(html).toContain('api.crm.example.com');
    expect(html).toContain('api.other-crm.example.net');

    // The signed definition is still the old one until the owner signs again.
    const stillOld = await withBusiness(BUSINESS, (db) => loadActiveCharter(db));
    expect(stillOld?.charter.externalSystems[0]?.baseUrl).toBe('https://api.crm.example.com/v1');

    expect((await signCrm(baseUrl, cookie)).status).toBe(303);
    const replaced = await withBusiness(BUSINESS, (db) => loadActiveCharter(db));
    expect(replaced?.charter.externalSystems.map((s) => s.baseUrl)).toEqual(['https://api.other-crm.example.net/v1']);
    expect(replaced?.charter.connections.filter((c) => c.system === 'ext:crm')).toHaveLength(1);
  });
});

describe('POST /connections/external/:system/remove', () => {
  it('removes the system: it no longer resolves, the binding is disconnected, and the secrets stay (as the page says)', async () => {
    await saveCrmDraft();
    await withBusiness(BUSINESS, (db) => putSecret(db, { ref: 'EXT_CRM_KEY', value: 'k', updatedBy: 'staff' }, key));
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    expect((await signCrm(baseUrl, cookie)).status).toBe(303);

    const status = await (await fetch(`${baseUrl}/connections/external`, { headers: { cookie } })).text();
    expect(status).toContain('action="/connections/external/crm/remove"');
    expect(status).toContain('הסודות');

    const res = await postForm(baseUrl, cookie, '/connections/external/crm/remove', {
      csrf: csrfFor(cookie),
      base: await activeVersion(),
      confirm: 'yes',
    });
    expect(res.status).toBe(303);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe('/connections/external?removed=crm');

    const active = await withBusiness(BUSINESS, (db) => loadActiveCharter(db));
    expect(active?.charter.externalSystems).toEqual([]);
    expect(active?.charter.connections.some((c) => c.system === 'ext:crm')).toBe(false);
    const bindings = await withBusiness(BUSINESS, (db) => loadBindings(db));
    expect(bindings.find((b) => b.system === 'ext:crm')?.status).toBe('disconnected');
    expect(resolveChannel(active!.bundle, bindings, 'ext.call', 'crm').status).toBe('no_channel');
    expect((await withBusiness(BUSINESS, (db) => listSecretRefs(db))).map((s) => s.ref)).toContain('EXT_CRM_KEY');

    const after = await (await fetch(`${baseUrl}${location}`, { headers: { cookie } })).text();
    expect(after).toContain('הסודות של המערכת נשארו שמורים');
    // No draft is left: re-adding needs the technician.
    expect(after).toContain(EXTERNAL_READD_NEEDS_TECHNICIAN);
    expect(after).not.toContain(EXTERNAL_READD_FROM_DRAFT);
  });

  it('refuses a stale base and a system that is not signed', async () => {
    await saveCrmDraft();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const notSigned = await postForm(baseUrl, cookie, '/connections/external/crm/remove', {
      csrf: csrfFor(cookie), base: await activeVersion(), confirm: 'yes',
    });
    expect(notSigned.status).toBe(409);
    expect((await signCrm(baseUrl, cookie)).status).toBe(303);
    const stale = await postForm(baseUrl, cookie, '/connections/external/crm/remove', { csrf: csrfFor(cookie), base: 'old', confirm: 'yes' });
    expect(stale.status).toBe(409);
    expect((await withBusiness(BUSINESS, (db) => loadActiveCharter(db)))?.charter.externalSystems).toHaveLength(1);
  });
});

describe('the gate before and after signing', () => {
  async function gateCall(): Promise<Awaited<ReturnType<typeof evaluateFor>>> {
    const active = await withBusiness(BUSINESS, (db) => loadActiveCharter(db));
    if (active === null) throw new Error('no charter');
    const job = await withBusiness(BUSINESS, (db) => createJob(db, { charterVersion: active.bundle.charterVersion, provenance: 'boss' }));
    const rampLevel = await withBusiness(BUSINESS, (db) => loadRampLevel(db, 'crm.write'));
    return evaluateFor(
      'ext.call',
      { system: 'crm', operation: 'update_customer', params: { customer_id: 'c1' } },
      {
        agent: 'ops.systems',
        bundle: active.bundle,
        jobId: job.jobId,
        stepId: 's1',
        provenance: 'boss',
        chainDepth: 0,
        counterpartyTags: [],
        rampLevel,
        businessId: BUSINESS,
        now: new Date('2026-08-18T09:00:00.000Z'),
      },
    );
  }

  it('a definition that exists only as a draft is denied external_operation_unknown; once signed it is not', async () => {
    await saveCrmDraft();
    const before = await gateCall();
    expect(before.outcome).toBe('deny');
    expect(before.outcome === 'deny' && before.code).toBe(DENY_CODES.externalOperationUnknown);

    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    expect((await signCrm(baseUrl, cookie)).status).toBe(303);

    const after = await gateCall();
    // Judged as the signed operation now (stopped later, at the dial's floor) — not unknown.
    expect(after.outcome === 'deny' ? after.code : after.outcome).not.toBe(DENY_CODES.externalOperationUnknown);
    expect(after.outcome === 'deny' && after.code).toBe(DENY_CODES.draftOnly);
  });
});

// ---------------------------------------------------------------------------
// Rollback: one transaction, proven by a failure injected at each later write
// ---------------------------------------------------------------------------

async function withFailingTrigger(table: string, event: 'INSERT' | 'UPDATE' | 'DELETE', fn: () => Promise<void>): Promise<void> {
  await testDb().query(
    `CREATE OR REPLACE FUNCTION t10_injected_failure() RETURNS trigger LANGUAGE plpgsql AS
     $fn$ BEGIN RAISE EXCEPTION 'injected failure'; END $fn$`,
  );
  await testDb().query(
    `CREATE TRIGGER t10_injected_failure BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION t10_injected_failure()`,
  );
  try {
    await fn();
  } finally {
    await testDb().query(`DROP TRIGGER IF EXISTS t10_injected_failure ON ${table}`);
    await testDb().query('DROP FUNCTION IF EXISTS t10_injected_failure()');
  }
}

async function auditCounts(): Promise<{ charter: number; binding: number }> {
  const { rows } = await testDb().query<{ kind: string; n: string }>(
    `SELECT kind, count(*)::text AS n FROM audit_log WHERE business_id = $1
      AND kind IN ('charter_change', 'connection_binding') GROUP BY kind`,
    [BUSINESS],
  );
  const of = (kind: string): number => Number(rows.find((r) => r.kind === kind)?.n ?? 0);
  return { charter: of('charter_change'), binding: of('connection_binding') };
}

describe('signing rolls back as one transaction', () => {
  it.each([
    ['the draft delete', 'external_system_drafts', 'DELETE'],
    ['the binding insert', 'connection_bindings', 'INSERT'],
  ] as const)('a failure at %s leaves the charter, bindings, draft and audit as they were', async (_label, table, event) => {
    await saveCrmDraft();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/connections/external/crm/sign`, { headers: { cookie } })).text();
    const version = await activeVersion();
    const audit = await auditCounts();

    await withFailingTrigger(table, event, async () => {
      const res = await postForm(baseUrl, cookie, '/connections/external/crm/sign', {
        csrf: csrfFor(cookie),
        base: hiddenField(html, 'base'),
        draftHash: hiddenField(html, 'draftHash'),
      });
      expect(res.status).toBe(500);
    });

    expect(await activeVersion()).toBe(version);
    expect((await withBusiness(BUSINESS, (db) => loadBindings(db))).some((b) => b.system === 'ext:crm')).toBe(false);
    expect(await withBusiness(BUSINESS, (db) => loadDrafts(db))).toHaveLength(1);
    expect(await auditCounts()).toEqual(audit);
  });

  it('a failure at the binding update during removal leaves the system signed and its binding live', async () => {
    await saveCrmDraft();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    expect((await signCrm(baseUrl, cookie)).status).toBe(303);
    const version = await activeVersion();
    const audit = await auditCounts();

    await withFailingTrigger('connection_bindings', 'UPDATE', async () => {
      const res = await postForm(baseUrl, cookie, '/connections/external/crm/remove', {
        csrf: csrfFor(cookie), base: version, confirm: 'yes',
      });
      expect(res.status).toBe(500);
    });

    expect(await activeVersion()).toBe(version);
    expect((await withBusiness(BUSINESS, (db) => loadActiveCharter(db)))?.charter.externalSystems).toHaveLength(1);
    expect((await withBusiness(BUSINESS, (db) => loadBindings(db))).find((b) => b.system === 'ext:crm')?.status).toBe('live');
    expect(await auditCounts()).toEqual(audit);
  });
});

// ---------------------------------------------------------------------------
// Wording: removal, re-adding, the subprocessor and identical drafts
// ---------------------------------------------------------------------------

describe('removal and re-adding wording', () => {
  it('removal needs the confirm checkbox; without it nothing is removed', async () => {
    await saveCrmDraft();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    expect((await signCrm(baseUrl, cookie)).status).toBe(303);
    const status = await (await fetch(`${baseUrl}/connections/external`, { headers: { cookie } })).text();
    expect(status).toContain('name="confirm" value="yes" required');
    expect(status).not.toContain('<script');
    const res = await postForm(baseUrl, cookie, '/connections/external/crm/remove', { csrf: csrfFor(cookie), base: await activeVersion() });
    expect(res.status).toBe(400);
    expect((await withBusiness(BUSINESS, (db) => loadActiveCharter(db)))?.charter.externalSystems).toHaveLength(1);
  });

  it('a draft left after removal: the notice says signing it brings the system back, and the sign page says re-add', async () => {
    await saveCrmDraft();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    expect((await signCrm(baseUrl, cookie)).status).toBe(303);
    await saveCrmDraft();
    const res = await postForm(baseUrl, cookie, '/connections/external/crm/remove', {
      csrf: csrfFor(cookie), base: await activeVersion(), confirm: 'yes',
    });
    expect(res.status).toBe(303);
    const notice = await (await fetch(`${baseUrl}${res.headers.get('location') ?? ''}`, { headers: { cookie } })).text();
    expect(notice).toContain(EXTERNAL_READD_FROM_DRAFT);
    expect(notice).not.toContain(EXTERNAL_READD_NEEDS_TECHNICIAN);

    const sign = await (await fetch(`${baseUrl}/connections/external/crm/sign`, { headers: { cookie } })).text();
    expect(sign).toContain('החזרת מערכת שהסרת');
    expect(sign).not.toContain('הוספת מערכת חיצונית');
  });

  it('a brand-new system is not called a re-add', async () => {
    await saveCrmDraft();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const sign = await (await fetch(`${baseUrl}/connections/external/crm/sign`, { headers: { cookie } })).text();
    expect(sign).toContain('הוספת מערכת חיצונית');
    expect(sign).not.toContain('החזרת מערכת שהסרת');
  });

  it('the subprocessor sentence appears only while ext:<id> is not yet allowed; a host change is named', async () => {
    await saveCrmDraft();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const first = await (await fetch(`${baseUrl}/connections/external/crm/sign`, { headers: { cookie } })).text();
    expect(first).toContain('תתווסף לרשימת הגורמים');
    expect(first).not.toContain('החברה שהנתונים יוצאים אליה משתנה');
    expect((await signCrm(baseUrl, cookie)).status).toBe(303);

    const changed = crmFixture();
    changed.baseUrl = 'https://api.other-crm.example.net/v1';
    await saveCrmDraft(changed);
    const second = await (await fetch(`${baseUrl}/connections/external/crm/sign`, { headers: { cookie } })).text();
    expect(second).not.toContain('תתווסף לרשימת הגורמים');
    expect(second).toContain(
      'החברה שהנתונים יוצאים אליה משתנה: <code>api.crm.example.com</code> → <code>api.other-crm.example.net</code>',
    );
  });

  it('a draft identical to the signed definition is not shown as a pending change', async () => {
    await saveCrmDraft();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    expect((await signCrm(baseUrl, cookie)).status).toBe(303);
    await saveCrmDraft();
    const status = await (await fetch(`${baseUrl}/connections/external`, { headers: { cookie } })).text();
    expect(status).not.toContain('טיוטת שינוי ממתינה');
    expect(status).toContain('חתומה בתקנון');

    const changed = crmFixture();
    changed.label = 'מערכת הלקוחות החדשה';
    await saveCrmDraft(changed);
    const pending = await (await fetch(`${baseUrl}/connections/external`, { headers: { cookie } })).text();
    expect(pending).toContain('טיוטת שינוי ממתינה');
  });
});
