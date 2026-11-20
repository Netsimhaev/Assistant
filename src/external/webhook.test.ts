/**
 * The signed webhook receiver (Stage D, Task 11). A real HTTP server around
 * `handleExternalWebhook` and real Postgres, plus a few requests through the
 * dashboard's own `createServer` to pin where the route sits: before the
 * session gate and the no-charter gate, and nowhere else.
 */
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
import { putSecret, storedCredentials } from '../governance/credential-store.js';
import { writeKeyState } from '../governance/master-key.js';
import { crmConnection, crmFixture, type ExternalSystemInput } from '../test/external-fixtures.js';
import { buildCharter } from '../test/fixtures.js';
import { registerBusiness, resetDatabase, testDb } from '../test/db.js';
import { TEST_MASTER_KEY } from '../test/owner.js';
import { createServer } from '../dashboard/server.js';
import { canonicalHash } from '../util/canonical.js';
import { buildErasurePlan } from '../governance/erasure-plan.js';
import { executeErasure } from '../governance/erasure.js';
import { EXTERNAL_HOOK_MAX_BYTES, EXTERNAL_HOOK_PATH, handleExternalWebhook } from './webhook.js';

const BUSINESS = 'hook-shop';
const OTHER = 'other-shop';
const SECRET = 'whsec_test_value';
const VERIFY = 'verify-token-1';

let server: Server | null = null;
let base = '';
let clock = new Date('2026-11-19T10:00:00Z');
/** Every handler call of the test server, so a test can await one and see it never rejected. */
let handled: Promise<void>[] = [];

const nowSeconds = (): number => Math.floor(clock.getTime() / 1000);

async function install(businessId: string, system: ExternalSystemInput | null): Promise<void> {
  await registerBusiness(businessId);
  await withBusiness(businessId, (db) =>
    installCharter(
      db,
      buildCharter(system === null ? {} : { externalSystems: [system], connections: [crmConnection()] }),
    ),
  );
}

async function storeSecret(businessId: string, ref: string, value: string): Promise<void> {
  await withBusiness(businessId, (db) => putSecret(db, { ref, value, updatedBy: 'test' }, TEST_MASTER_KEY));
}

async function startHandler(): Promise<void> {
  const secrets = storedCredentials(TEST_MASTER_KEY);
  server = createHttpServer((req, res) => {
    handled.push(handleExternalWebhook(req, res, { secrets, now: () => clock }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  await resetDatabase();
  clock = new Date('2026-11-19T10:00:00Z');
  handled = [];
  await writeKeyState(TEST_MASTER_KEY, 'KEY-test', testDb());
  await install(BUSINESS, crmFixture());
  await storeSecret(BUSINESS, 'EXT_CRM_HOOK', SECRET);
  await startHandler();
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

function hmacHex(payload: string | Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function stripeHeader(body: string, ts = nowSeconds(), extra: string[] = []): string {
  return [`t=${ts}`, ...extra, `v1=${hmacHex(`${ts}.${body}`)}`].join(',');
}

async function post(
  path: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(`${base}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const HOOK = `/hooks/ext/${BUSINESS}/crm`;

async function eventRows(): Promise<{ business_id: string; event_type: string; fields: unknown; source: string }[]> {
  const { rows } = await testDb().query<{ business_id: string; event_type: string; fields: unknown; source: string }>(
    'SELECT business_id, event_type, fields, source FROM external_events ORDER BY event_id',
  );
  return rows;
}

async function rejected(businessId = BUSINESS): Promise<number> {
  const { rows } = await testDb().query<{ rejected_hooks: number }>(
    'SELECT rejected_hooks FROM external_system_state WHERE business_id = $1 AND system_id = $2',
    [businessId, 'crm'],
  );
  return rows[0]?.rejected_hooks ?? 0;
}

const CREATED = JSON.stringify({
  type: 'customer.created',
  data: { name: 'דנה כהן', secret_note: 'not declared', email: 'dana@x.example' },
});

describe('EXTERNAL_HOOK_PATH', () => {
  it('matches exactly two segments under /hooks/ext/, anchored', () => {
    expect(EXTERNAL_HOOK_PATH.test('/hooks/ext/hook-shop/crm')).toBe(true);
    expect(EXTERNAL_HOOK_PATH.test('/hooks/ext/hook-shop/crm/x')).toBe(false);
    expect(EXTERNAL_HOOK_PATH.test('/x/hooks/ext/hook-shop/crm')).toBe(false);
    expect(EXTERNAL_HOOK_PATH.test('/hooks/ext/hook-shop')).toBe(false);
    expect(EXTERNAL_HOOK_PATH.test('/hooks/ext//crm')).toBe(false);
  });
});

describe('hmac-sha256, Stripe-style kv header over {timestamp}.{body}', () => {
  it('a valid signature returns 202 and stores one row with only the declared fields', async () => {
    const res = await post(HOOK, CREATED, { 'Stripe-Signature': stripeHeader(CREATED) });
    expect(res.status).toBe(202);
    expect(res.text).toBe('');
    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ business_id: BUSINESS, event_type: 'customer.created', source: 'webhook' });
    expect(rows[0]?.fields).toEqual([{ label: 'שם', value: 'דנה כהן' }]);
    expect(JSON.stringify(rows[0]?.fields)).not.toContain('not declared');
    expect(await rejected()).toBe(0);
  });

  it('a repeated delivery stores one row', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await post(HOOK, CREATED, { 'Stripe-Signature': stripeHeader(CREATED) });
      expect(res.status).toBe(202);
    }
    expect(await eventRows()).toHaveLength(1);
  });

  it('a timestamp 301 seconds old is refused; 300 seconds is accepted', async () => {
    const old = await post(HOOK, CREATED, { 'Stripe-Signature': stripeHeader(CREATED, nowSeconds() - 301) });
    expect(old.status).toBe(401);
    expect(old.text).toBe('');
    expect(await eventRows()).toHaveLength(0);
    expect(await rejected()).toBe(1);
    const future = await post(HOOK, CREATED, { 'Stripe-Signature': stripeHeader(CREATED, nowSeconds() + 301) });
    expect(future.status).toBe(401);
    const edge = await post(HOOK, CREATED, { 'Stripe-Signature': stripeHeader(CREATED, nowSeconds() - 300) });
    expect(edge.status).toBe(202);
  });

  it('two v1 values of which one matches pass', async () => {
    const res = await post(HOOK, CREATED, { 'Stripe-Signature': stripeHeader(CREATED, nowSeconds(), [`v1=${'0'.repeat(64)}`]) });
    expect(res.status).toBe(202);
  });

  it('the same JSON re-serialised with the old signature is refused (the HMAC is over the raw bytes)', async () => {
    const header = stripeHeader(CREATED);
    const reserialised = JSON.stringify(JSON.parse(CREATED), null, 2);
    const res = await post(HOOK, reserialised, { 'Stripe-Signature': header });
    expect(res.status).toBe(401);
    expect(await eventRows()).toHaveLength(0);
  });

  it('a signature made with another secret is refused', async () => {
    const ts = nowSeconds();
    const header = `t=${ts},v1=${hmacHex(`${ts}.${CREATED}`, 'other-secret')}`;
    expect((await post(HOOK, CREATED, { 'Stripe-Signature': header })).status).toBe(401);
  });

  it('a missing, short or malformed header is a 401 without throwing', async () => {
    const ts = nowSeconds();
    const sig = hmacHex(`${ts}.${CREATED}`);
    for (const header of [
      undefined,
      '',
      'v1=ab',
      `t=${ts}`,
      `v1=${sig}`,
      `t=abc,v1=${sig}`,
      `t=${ts}.5,v1=${sig}`,
      `t=${ts},t=${ts},v1=${sig}`,
      `t=-${ts},v1=${sig}`,
      `t=${ts},v1=${sig.slice(0, 10)}`,
      `t=${ts},v1=${'zz'.repeat(32)}`,
      `t=${ts},${Array.from({ length: 11 }, () => `v1=${sig}`).join(',')}`,
    ]) {
      const res = await post(HOOK, CREATED, header === undefined ? {} : { 'Stripe-Signature': header });
      expect(res.status, String(header)).toBe(401);
      expect(res.text).toBe('');
    }
    expect(await eventRows()).toHaveLength(0);
  });

  it('a valid signature on an unknown event type returns 202, stores nothing and is counted', async () => {
    const body = JSON.stringify({ type: 'invoice.paid', data: { name: 'x' } });
    const res = await post(HOOK, body, { 'Stripe-Signature': stripeHeader(body) });
    expect(res.status).toBe(202);
    expect(await eventRows()).toHaveLength(0);
    expect(await rejected()).toBe(1);
  });

  it('a type that is not a string (an inherited name included) is an unknown type', async () => {
    for (const body of [JSON.stringify({ data: {} }), JSON.stringify({ type: { a: 1 } }), JSON.stringify({ type: 'constructor' })]) {
      const res = await post(HOOK, body, { 'Stripe-Signature': stripeHeader(body) });
      expect(res.status).toBe(202);
    }
    expect(await eventRows()).toHaveLength(0);
  });

  it('a signed body that is not JSON is a 401 and stores nothing', async () => {
    const body = '{not json';
    const res = await post(HOOK, body, { 'Stripe-Signature': stripeHeader(body) });
    expect(res.status).toBe(401);
    expect(await eventRows()).toHaveLength(0);
    expect(await rejected()).toBe(1);
  });

  it('a body over 256 KB is a 413', async () => {
    const big = Buffer.alloc(EXTERNAL_HOOK_MAX_BYTES + 1, 0x20);
    const res = await post(HOOK, big, { 'Stripe-Signature': 't=1,v1=00' });
    expect(res.status).toBe(413);
    expect(await eventRows()).toHaveLength(0);
  });

  it('a missing secret is a 401, and counted', async () => {
    await withBusiness(BUSINESS, (db) => db.query("DELETE FROM credentials WHERE business_id = $1 AND ref = 'EXT_CRM_HOOK'", [BUSINESS]));
    const res = await post(HOOK, CREATED, { 'Stripe-Signature': stripeHeader(CREATED) });
    expect(res.status).toBe(401);
    expect(await rejected()).toBe(1);
  });
});

describe('the business and the system come from the path, and only the path', () => {
  it('an unknown business, a malformed one, or a suspended one is a 401 with no row anywhere', async () => {
    for (const path of ['/hooks/ext/nobody-here/crm', '/hooks/ext/BAD_ID/crm', '/hooks/ext/produced/crm']) {
      const res = await post(path, CREATED, { 'Stripe-Signature': stripeHeader(CREATED) });
      expect(res.status, path).toBe(401);
    }
    await registerBusiness(BUSINESS, 'suspended');
    const suspended = await post(HOOK, CREATED, { 'Stripe-Signature': stripeHeader(CREATED) });
    expect(suspended.status).toBe(401);
    expect(await eventRows()).toHaveLength(0);
    const { rows } = await testDb().query('SELECT 1 FROM external_system_state');
    expect(rows).toHaveLength(0);
  });

  it('a system not in the charter, or a malformed system id, is a 401 with no row', async () => {
    for (const path of [`/hooks/ext/${BUSINESS}/books`, `/hooks/ext/${BUSINESS}/CRM`, `/hooks/ext/${BUSINESS}/__proto__`]) {
      const res = await post(path, CREATED, { 'Stripe-Signature': stripeHeader(CREATED) });
      expect(res.status, path).toBe(401);
    }
    const { rows } = await testDb().query('SELECT 1 FROM external_system_state');
    expect(rows).toHaveLength(0);
  });

  it('a system signed without a webhook is a 401 with no row', async () => {
    await withBusiness(BUSINESS, (db) =>
      installCharter(db, buildCharter({ version: '2026-11-19.2', externalSystems: [{ ...crmFixture(), webhook: null }], connections: [crmConnection()] })),
    );
    expect((await post(HOOK, CREATED, { 'Stripe-Signature': stripeHeader(CREATED) })).status).toBe(401);
    const { rows } = await testDb().query('SELECT 1 FROM external_system_state');
    expect(rows).toHaveLength(0);
  });

  it("another business's URL with this business's signature stores nothing in either", async () => {
    await install(OTHER, null);
    const res = await post(`/hooks/ext/${OTHER}/crm`, CREATED, { 'Stripe-Signature': stripeHeader(CREATED) });
    expect(res.status).toBe(401);
    expect(await eventRows()).toHaveLength(0);
  });

  it('a business that exists but has no charter yet is a 401', async () => {
    await registerBusiness(OTHER);
    expect((await post(`/hooks/ext/${OTHER}/crm`, CREATED, { 'Stripe-Signature': stripeHeader(CREATED) })).status).toBe(401);
  });

  it('a method other than GET and POST is a 405', async () => {
    const res = await fetch(`${base}${HOOK}`, { method: 'PUT', body: CREATED });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, POST');
  });
});

describe('hmac-sha256, GitHub-style prefixed header over {body}', () => {
  beforeEach(async () => {
    const system = crmFixture();
    system.webhook = {
      scheme: {
        kind: 'hmac-sha256',
        encoding: 'hex',
        signature: { from: 'header', header: 'X-Hub-Signature-256', prefix: 'sha256=' },
        signedPayload: '{body}',
        timestamp: null,
      },
      typePath: null,
      events: [{ type: 'push', label: 'דחיפה', fields: [{ path: 'ref', label: 'ענף' }] }],
      handshake: null,
    };
    await withBusiness(BUSINESS, (db) =>
      installCharter(db, buildCharter({ version: '2026-11-19.2', externalSystems: [system], connections: [crmConnection()] })),
    );
  });

  const body = JSON.stringify({ ref: 'refs/heads/main', other: 1 });

  it('`sha256=<hex>` passes, and the single declared event is stored without a type path', async () => {
    const res = await post(HOOK, body, { 'X-Hub-Signature-256': `sha256=${hmacHex(body)}` });
    expect(res.status).toBe(202);
    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: 'push', fields: [{ label: 'ענף', value: 'refs/heads/main' }] });
  });

  it('the same hex without the prefix is a 401', async () => {
    expect((await post(HOOK, body, { 'X-Hub-Signature-256': hmacHex(body) })).status).toBe(401);
  });

  it('upper-case hex is accepted', async () => {
    expect((await post(HOOK, body, { 'X-Hub-Signature-256': `sha256=${hmacHex(body).toUpperCase()}` })).status).toBe(202);
  });
});

describe('shared-secret header', () => {
  beforeEach(async () => {
    const system = crmFixture();
    system.webhook = {
      scheme: { kind: 'shared-secret', header: 'X-Webhook-Token' },
      typePath: 'type',
      events: [{ type: 'customer.created', label: 'לקוח חדש', fields: [{ path: 'data.name', label: 'שם' }] }],
      handshake: null,
    };
    await withBusiness(BUSINESS, (db) =>
      installCharter(db, buildCharter({ version: '2026-11-19.2', externalSystems: [system], connections: [crmConnection()] })),
    );
  });

  it('the right secret passes; a wrong, longer or shorter one is a 401', async () => {
    expect((await post(HOOK, CREATED, { 'X-Webhook-Token': SECRET })).status).toBe(202);
    for (const wrong of [`${SECRET}x`, SECRET.slice(1), 'nope', '']) {
      expect((await post(HOOK, CREATED, { 'X-Webhook-Token': wrong })).status, wrong).toBe(401);
    }
    expect((await post(HOOK, CREATED)).status).toBe(401);
  });
});

describe('query_challenge handshake (Meta)', () => {
  beforeEach(async () => {
    const system = crmFixture();
    system.webhook = {
      scheme: {
        kind: 'hmac-sha256',
        encoding: 'hex',
        signature: { from: 'header', header: 'X-Hub-Signature-256', prefix: 'sha256=' },
      },
      typePath: 'type',
      events: [{ type: 'customer.created', label: 'לקוח חדש', fields: [] }],
      handshake: {
        kind: 'query_challenge',
        modeParam: 'hub.mode',
        modeValue: 'subscribe',
        tokenParam: 'hub.verify_token',
        challengeParam: 'hub.challenge',
      },
    };
    await withBusiness(BUSINESS, (db) =>
      installCharter(db, buildCharter({ version: '2026-11-19.2', externalSystems: [system], connections: [crmConnection()] })),
    );
    await storeSecret(BUSINESS, 'EXT_CRM_VERIFY', VERIFY);
  });

  const get = (query: string): Promise<Response> => fetch(`${base}${HOOK}?${query}`);

  it('the right verify token returns exactly the challenge as text/plain and stores nothing', async () => {
    const res = await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('1158201444');
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await eventRows()).toHaveLength(0);
    expect(await rejected()).toBe(0);
  });

  it('a wrong token, a wrong mode, a challenge with `<` or over 200 characters, or a repeated param is a 401', async () => {
    const long = 'a'.repeat(201);
    for (const query of [
      `hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`,
      `hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`,
      `hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=%3Cscript%3E`,
      `hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=${long}`,
      `hub.mode=subscribe&hub.verify_token=${VERIFY}`,
      `hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1&hub.challenge=2`,
      `hub.mode=subscribe&hub.challenge=1`,
    ]) {
      const res = await get(query);
      expect(res.status, query).toBe(401);
      expect(await res.text()).toBe('');
    }
    expect(await eventRows()).toHaveLength(0);
  });

  it('a 200-character challenge is answered', async () => {
    const challenge = 'a'.repeat(200);
    const res = await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=${challenge}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(challenge);
  });

  it('without a stored verify token nothing is answered', async () => {
    await withBusiness(BUSINESS, (db) => db.query("DELETE FROM credentials WHERE business_id = $1 AND ref = 'EXT_CRM_VERIFY'", [BUSINESS]));
    expect((await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`)).status).toBe(401);
  });
});

describe('a GET on a system without a query_challenge handshake', () => {
  it('is a 401, and not counted: it presented no credential (ruling T11-c)', async () => {
    const res = await fetch(`${base}${HOOK}?hub.mode=subscribe&hub.challenge=1`);
    expect(res.status).toBe(401);
    expect(await rejected()).toBe(0);
  });
});

describe('the reject counter counts failed authentication only (ruling T11-c)', () => {
  it('a bare POST with no signature header is refused and not counted', async () => {
    const res = await post(HOOK, CREATED);
    expect(res.status).toBe(401);
    expect(res.text).toBe('');
    const empty = await post(HOOK, CREATED, { 'Stripe-Signature': '' });
    expect(empty.status).toBe(401);
    expect(await rejected()).toBe(0);
  });

  it('a request that presented a bad signature is refused and counted', async () => {
    const ts = nowSeconds();
    const res = await post(HOOK, CREATED, { 'Stripe-Signature': `t=${ts},v1=${'0'.repeat(64)}` });
    expect(res.status).toBe(401);
    expect(await rejected()).toBe(1);
  });
});

describe('a broken request stream', () => {
  it('an aborted body never rejects the handler, and stores nothing', async () => {
    const { connect } = await import('node:net');
    const url = new URL(base);
    const socket = connect(Number(url.port), url.hostname);
    await once(socket, 'connect');
    const CRLF = String.fromCharCode(13, 10);
    socket.write(
      [
        `POST ${HOOK} HTTP/1.1`,
        'Host: x',
        'Content-Type: application/json',
        'Content-Length: 1000',
        `Stripe-Signature: t=${nowSeconds()},v1=${'0'.repeat(64)}`,
        '',
        '{"type":',
      ].join(CRLF),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(handled).toHaveLength(1);
    await expect(handled[0]).resolves.toBeUndefined();
    expect(await eventRows()).toHaveLength(0);
    expect(await rejected()).toBe(0);
  });
});

describe('body_challenge handshake (Slack url_verification)', () => {
  beforeEach(async () => {
    const system = crmFixture();
    system.webhook = {
      scheme: {
        kind: 'hmac-sha256',
        encoding: 'hex',
        signature: { from: 'header', header: 'X-Slack-Signature', prefix: 'v0=' },
        signedPayload: 'v0:{timestamp}:{body}',
        timestamp: { from: 'header', header: 'X-Slack-Request-Timestamp' },
      },
      typePath: 'type',
      events: [{ type: 'event_callback', label: 'אירוע', fields: [] }],
      handshake: { kind: 'body_challenge', typeValue: 'url_verification', challengePath: 'challenge' },
    };
    await withBusiness(BUSINESS, (db) =>
      installCharter(db, buildCharter({ version: '2026-11-19.2', externalSystems: [system], connections: [crmConnection()] })),
    );
  });

  function slackHeaders(body: string, ts = nowSeconds()): Record<string, string> {
    return { 'X-Slack-Request-Timestamp': String(ts), 'X-Slack-Signature': `v0=${hmacHex(`v0:${ts}:${body}`)}` };
  }

  it('a valid signature returns the challenge and stores nothing', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc.DEF_123-x', token: 'ignored' });
    const res = await post(HOOK, body, slackHeaders(body));
    expect(res.status).toBe(200);
    expect(res.text).toBe('abc.DEF_123-x');
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await eventRows()).toHaveLength(0);
  });

  it('without a valid signature it is a 401', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    const res = await post(HOOK, body, { ...slackHeaders(body), 'X-Slack-Signature': `v0=${'0'.repeat(64)}` });
    expect(res.status).toBe(401);
    expect(res.text).toBe('');
  });

  it('a challenge outside the allowed characters is a 401', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: '<img src=x>' });
    expect((await post(HOOK, body, slackHeaders(body))).status).toBe(401);
  });

  it('a normal signed event is stored', async () => {
    const body = JSON.stringify({ type: 'event_callback', event: {} });
    expect((await post(HOOK, body, slackHeaders(body))).status).toBe(202);
    expect(await eventRows()).toHaveLength(1);
  });
});

describe('through the dashboard server', () => {
  let dash: Server | null = null;
  let dashBase = '';
  beforeEach(async () => {
    dash = createServer({ masterKey: TEST_MASTER_KEY, port: 0, dashboardBaseUrl: 'http://127.0.0.1:4173' });
    await once(dash, 'listening');
    dashBase = `http://127.0.0.1:${(dash.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => dash?.close(() => resolve()));
    dash = null;
  });

  it('needs no session or CSRF token', async () => {
    // The dashboard's own clock: sign with the real time.
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=${hmacHex(`${ts}.${CREATED}`)}`;
    const res = await fetch(`${dashBase}${HOOK}`, { method: 'POST', body: CREATED, headers: { 'Stripe-Signature': header } });
    expect(res.status).toBe(202);
    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fields).toEqual([{ label: 'שם', value: 'דנה כהן' }]);
  });

  it('is a 401 — not a redirect to /setup — for a business with no charter', async () => {
    await registerBusiness(OTHER);
    const res = await fetch(`${dashBase}/hooks/ext/${OTHER}/crm`, { method: 'POST', body: CREATED, redirect: 'manual' });
    expect(res.status).toBe(401);
  });

  it('does not serve any other path', async () => {
    const res = await fetch(`${dashBase}${HOOK}/extra`, { method: 'POST', body: CREATED, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('a PUT is a 405', async () => {
    const res = await fetch(`${dashBase}${HOOK}`, { method: 'PUT', body: CREATED });
    expect(res.status).toBe(405);
  });
});

describe('item hash', () => {
  it('two different event types with the same declared fields are two rows', async () => {
    const a = JSON.stringify({ type: 'customer.created', data: {} });
    const b = JSON.stringify({ type: 'payment.failed', data: {} });
    expect((await post(HOOK, a, { 'Stripe-Signature': stripeHeader(a) })).status).toBe(202);
    expect((await post(HOOK, b, { 'Stripe-Signature': stripeHeader(b) })).status).toBe(202);
    expect(await eventRows()).toHaveLength(2);
    expect(canonicalHash({ eventType: 'customer.created', fields: [] })).not.toBe(canonicalHash({ eventType: 'payment.failed', fields: [] }));
  });
});

describe('an erased item does not come back (I3, migration 080)', () => {
  async function eraseDana(): Promise<void> {
    const plan = await withBusiness(BUSINESS, (db) => buildErasurePlan(db, { kind: 'contact', identifier: 'דנה כהן' }));
    expect(plan.externalEventIds).toHaveLength(1);
    await withBusiness(BUSINESS, (db) => executeErasure(db, plan));
  }

  it('the same alert re-delivered after an erasure stores nothing; a changed record is stored', async () => {
    expect((await post(HOOK, CREATED, { 'Stripe-Signature': stripeHeader(CREATED) })).status).toBe(202);
    await eraseDana();
    expect(await eventRows()).toHaveLength(0);
    const tombstones = await testDb().query<{ system_id: string; item_hash: string }>(
      'SELECT system_id, item_hash FROM external_erased_items WHERE business_id = $1',
      [BUSINESS],
    );
    expect(tombstones.rows).toEqual([
      { system_id: 'crm', item_hash: canonicalHash({ eventType: 'customer.created', fields: [{ label: 'שם', value: 'דנה כהן' }] }) },
    ]);

    const again = await post(HOOK, CREATED, { 'Stripe-Signature': stripeHeader(CREATED) });
    expect(again.status).toBe(202);
    expect(await eventRows()).toHaveLength(0);

    const changed = JSON.stringify({ type: 'customer.created', data: { name: 'דנה כהן-לוי' } });
    expect((await post(HOOK, changed, { 'Stripe-Signature': stripeHeader(changed) })).status).toBe(202);
    const rows = await eventRows();
    expect(rows.map((r) => r.fields)).toEqual([[{ label: 'שם', value: 'דנה כהן-לוי' }]]);
  });
});
