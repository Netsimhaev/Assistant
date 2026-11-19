/**
 * The daily scan (Stage D, Task 12, ruling 9): the signed scan operation run
 * on a timer through the adapter's own path — real Postgres, a fake HTTP
 * client for the far end, and the REAL guarded client for the address guard.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
import { putSecret, storedCredentials } from '../governance/credential-store.js';
import { writeKeyState } from '../governance/master-key.js';
import { upsertBinding } from '../orchestrator/bindings.js';
import { crmConnection, crmFixture, type ExternalSystemInput } from '../test/external-fixtures.js';
import { buildCharter } from '../test/fixtures.js';
import { registerBusiness, resetDatabase, testDb } from '../test/db.js';
import { TEST_MASTER_KEY } from '../test/owner.js';
import { createGuardedHttps, type ExternalHttp, type ExternalRequest, type ExternalResult } from './http.js';
import { MAX_SCAN_ITEMS, SCAN_RETRY_MS, scanExternalSystems } from './scan.js';
import type { BusinessDb } from '../db/pool.js';
import { trip } from '../governance/killswitch.js';
import { loadSystemState } from './store.js';
import { buildErasurePlan } from '../governance/erasure-plan.js';
import { executeErasure } from '../governance/erasure.js';

const BUSINESS = 'scan-shop';
const KEY = 'sk_test_scan_key';
const T0 = new Date('2026-11-19T08:00:00Z');
const HOUR = 60 * 60 * 1000;

function fakeHttp(answer: () => ExternalResult): ExternalHttp & { requests: ExternalRequest[] } {
  const requests: ExternalRequest[] = [];
  return {
    requests,
    send: async (req) => {
      requests.push(req);
      return answer();
    },
  };
}

const LIST = JSON.stringify({
  data: [
    { id: 'c1', name: 'דנה כהן', email: 'dana@x.example', internal: 'not declared' },
    { id: 'c2', name: 'רון לוי', email: 'ron@x.example' },
  ],
});
const ok = (body: string = LIST): ExternalResult => ({ kind: 'response', status: 200, body });

async function install(system: ExternalSystemInput = crmFixture()): Promise<void> {
  await withBusiness(BUSINESS, (db) =>
    installCharter(db, buildCharter({ externalSystems: [system], connections: [crmConnection()] })),
  );
}

async function connect(status: 'live' | 'disconnected' = 'live'): Promise<void> {
  await withBusiness(BUSINESS, (db) =>
    upsertBinding(
      db,
      { system: 'ext:crm', status, endpoint: null, credentialRef: 'EXT_CRM_KEY', provider: null, lastOkAt: null, lastError: null },
      { by: 'test' },
    ),
  );
  await withBusiness(BUSINESS, (db) => putSecret(db, { ref: 'EXT_CRM_KEY', value: KEY, updatedBy: 'test' }, TEST_MASTER_KEY));
}

function scan(http: ExternalHttp, now: Date, capPerDay?: number) {
  return withBusiness(BUSINESS, (db) =>
    scanExternalSystems(db, {
      http,
      credentials: storedCredentials(TEST_MASTER_KEY),
      now,
      ...(capPerDay !== undefined ? { capPerDay } : {}),
    }),
  );
}

async function events(): Promise<{ source: string; event_type: string; fields: { label: string; value: string }[] }[]> {
  const { rows } = await testDb().query<{ source: string; event_type: string; fields: { label: string; value: string }[] }>(
    `SELECT source, event_type, fields FROM external_events WHERE business_id = $1 ORDER BY created_at, event_id`,
    [BUSINESS],
  );
  return rows;
}

async function calls(): Promise<string[]> {
  const { rows } = await testDb().query<{ outcome: string }>(
    `SELECT outcome FROM external_calls WHERE business_id = $1 ORDER BY at`,
    [BUSINESS],
  );
  return rows.map((r) => r.outcome);
}

beforeEach(async () => {
  await resetDatabase();
  await registerBusiness(BUSINESS);
  await writeKeyState(TEST_MASTER_KEY, 'KEY-test', testDb());
});
afterAll(async () => {
  await closePool();
});

describe('scanExternalSystems', () => {
  it('runs the signed scan op once, splits items, stores declared fields only, and counts the call', async () => {
    await install();
    await connect();
    const http = fakeHttp(() => ok());

    const out = await scan(http, T0);
    expect(out).toMatchObject({ scanned: 1, newItems: 2, skipped: 0, warnings: [] });

    expect(http.requests).toHaveLength(1);
    const req = http.requests[0];
    expect(req?.method).toBe('GET');
    expect(req?.url.href).toBe('https://api.crm.example.com/v1/customers');
    // First scan: no `since` value yet, so the param is omitted.
    expect(req?.url.searchParams.has('updated_since')).toBe(false);
    expect(req?.headers['Authorization']).toBe(`Bearer ${KEY}`);

    const rows = await events();
    expect(rows.map((r) => [r.source, r.event_type])).toEqual([
      ['scan', 'list_customers'],
      ['scan', 'list_customers'],
    ]);
    expect(rows[0]?.fields).toEqual([
      { label: 'שם', value: 'דנה כהן' },
      { label: 'מייל', value: 'dana@x.example' },
    ]);
    expect(JSON.stringify(rows)).not.toContain('not declared');
    expect(await calls()).toEqual(['ok']);

    const state = await withBusiness(BUSINESS, (db) => loadSystemState(db, 'crm'));
    expect(state?.lastScanAt?.toISOString()).toBe(T0.toISOString());
    expect(state?.lastScanOutcome).toBe('ok');
  });

  it('runs only when everyHours have passed, and sends since = the last successful scan', async () => {
    await install();
    await connect();
    const http = fakeHttp(() => ok());
    await scan(http, T0);

    const early = await scan(http, new Date(T0.getTime() + 23 * HOUR));
    expect(early).toMatchObject({ scanned: 0, skipped: 1 });
    expect(http.requests).toHaveLength(1);

    const due = await scan(http, new Date(T0.getTime() + 24 * HOUR));
    expect(due.scanned).toBe(1);
    expect(http.requests).toHaveLength(2);
    expect(http.requests[1]?.url.searchParams.get('updated_since')).toBe(T0.toISOString());
  });

  it('a response unchanged since the last scan inserts nothing', async () => {
    await install();
    await connect();
    const http = fakeHttp(() => ok());
    await scan(http, T0);
    expect(await events()).toHaveLength(2);

    const again = await scan(http, new Date(T0.getTime() + 24 * HOUR));
    expect(again).toMatchObject({ scanned: 1, newItems: 0 });
    expect(await events()).toHaveLength(2);
  });

  it('a scan blocked by the address guard inserts nothing, records the call, and keeps last_scan_at', async () => {
    await install();
    await connect();
    // The REAL guarded client, with DNS pointed at loopback: the real guard refuses.
    const http = createGuardedHttps({ __testOnly: { resolve: async () => [{ address: '127.0.0.1', family: 4 }] } });

    const out = await scan(http, T0);
    expect(out.scanned).toBe(1);
    expect(out.newItems).toBe(0);
    expect(await events()).toHaveLength(0);
    expect(await calls()).toEqual(['external_address_refused']);
    const state = await withBusiness(BUSINESS, (db) => loadSystemState(db, 'crm'));
    expect(state?.lastScanAt).toBeNull();
    expect(state?.lastScanOutcome).toBe('external_address_refused');
  });

  it('a failed scan waits SCAN_RETRY_MS before trying again, and its window stays where it was', async () => {
    await install();
    await connect();
    let answer: ExternalResult = { kind: 'response', status: 503, body: 'down' };
    const http = fakeHttp(() => answer);
    await scan(http, T0);
    expect(await events()).toHaveLength(0);

    await scan(http, new Date(T0.getTime() + SCAN_RETRY_MS - 1));
    expect(http.requests).toHaveLength(1);

    answer = ok();
    const retry = await scan(http, new Date(T0.getTime() + SCAN_RETRY_MS));
    expect(retry.newItems).toBe(2);
    // No successful scan before, so still no `since`.
    expect(http.requests[1]?.url.searchParams.has('updated_since')).toBe(false);
  });

  it('the daily cap stops the scan before anything is sent', async () => {
    await install();
    await connect();
    const http = fakeHttp(() => ok());
    const out = await scan(http, T0, 0);
    expect(out.scanned).toBe(1);
    expect(http.requests).toHaveLength(0);
    expect(await events()).toHaveLength(0);
    expect((await withBusiness(BUSINESS, (db) => loadSystemState(db, 'crm')))?.lastScanOutcome).toBe('external_disabled');
  });

  it('drops a field that echoes the secret', async () => {
    await install();
    await connect();
    const http = fakeHttp(() => ok(JSON.stringify({ data: [{ name: `token ${KEY}`, email: 'a@b.example' }] })));
    await scan(http, T0);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });

  it('itemsPath null: the whole response is one item', async () => {
    const def = crmFixture();
    def.scan = { operation: 'list_customers', sinceParam: null, itemsPath: null, everyHours: 6 };
    await install(def);
    await connect();
    const http = fakeHttp(() => ok(JSON.stringify({ name: 'דנה', email: 'd@x.example' })));
    const out = await scan(http, T0);
    expect(out.newItems).toBe(1);
  });

  it('scans nothing without a live binding, and nothing for a system the active charter does not carry', async () => {
    await install();
    await connect('disconnected');
    const http = fakeHttp(() => ok());
    expect((await scan(http, T0)).skipped).toBe(1);
    expect(http.requests).toHaveLength(0);

    // A charter without the system: a removed system is never scanned, whatever its binding says.
    await resetDatabase();
    await registerBusiness(BUSINESS);
    await writeKeyState(TEST_MASTER_KEY, 'KEY-test', testDb());
    await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter({})));
    await connect();
    const out = await scan(http, T0);
    expect(out).toMatchObject({ scanned: 0, skipped: 0, newItems: 0 });
    expect(http.requests).toHaveLength(0);
  });

  it.each(['all', 'outbound', 'operations'] as const)('the %s kill switch stops the scan before anything is sent', async (scope) => {
    await install();
    await connect();
    await withBusiness(BUSINESS, (db) => trip(db, scope, 'owner', 'test'));
    const http = fakeHttp(() => ok());
    const out = await scan(http, T0);
    expect(out).toMatchObject({ scanned: 0, skipped: 1, newItems: 0 });
    expect(http.requests).toHaveLength(0);
    expect(await calls()).toEqual([]);
  });

  it('a list longer than MAX_SCAN_ITEMS is cut, said, and does not move last_scan_at; a repeat stores no duplicate', async () => {
    await install();
    await connect();
    const many = JSON.stringify({ data: Array.from({ length: 250 }, (_, i) => ({ name: `לקוח ${i}`, email: `c${i}@x.example` })) });
    const http = fakeHttp(() => ok(many));

    const first = await scan(http, T0);
    expect(MAX_SCAN_ITEMS).toBe(200);
    expect(first).toMatchObject({ scanned: 1, newItems: 200, truncated: 1 });
    expect(first.warnings.join(' ')).toContain('more than 200');
    expect(await events()).toHaveLength(200);
    const state = await withBusiness(BUSINESS, (db) => loadSystemState(db, 'crm'));
    expect(state?.lastScanAt).toBeNull();
    expect(state?.lastScanOutcome).toBe('scan_truncated');

    // The next attempt asks from the same point (no since yet) and stores no duplicate.
    const again = await scan(http, new Date(T0.getTime() + SCAN_RETRY_MS));
    expect(again).toMatchObject({ scanned: 1, newItems: 0, truncated: 1 });
    expect(http.requests[1]?.url.searchParams.has('updated_since')).toBe(false);
    expect(await events()).toHaveLength(200);
  });

  it('a throw while storing items keeps what was stored, records scan_failed, and backs off', async () => {
    await install();
    await connect();
    const http = fakeHttp(() => ok());
    let inserts = 0;
    const out = await withBusiness(BUSINESS, (real) => {
      const db: BusinessDb = {
        businessId: real.businessId,
        inTransaction: real.inTransaction,
        query: ((text: string, values?: unknown[]) => {
          if (text.includes('INSERT INTO external_events')) {
            inserts += 1;
            if (inserts === 2) throw new Error('db fault');
          }
          return real.query(text, values as never);
        }) as BusinessDb['query'],
      };
      return scanExternalSystems(db, { http, credentials: storedCredentials(TEST_MASTER_KEY), now: T0 });
    });
    expect(out.warnings.join(' ')).toContain('failed');
    expect(await events()).toHaveLength(1);
    const state = await withBusiness(BUSINESS, (db) => loadSystemState(db, 'crm'));
    expect(state?.lastScanOutcome).toBe('scan_failed');
    expect(state?.lastScanAttemptAt?.toISOString()).toBe(T0.toISOString());
    expect(state?.lastScanAt).toBeNull();

    await scan(http, new Date(T0.getTime() + SCAN_RETRY_MS - 1));
    expect(http.requests).toHaveLength(1);
  });

  it('an unreadable charter scans nothing and says so', async () => {
    await install();
    await connect();
    await testDb().query(
      `UPDATE charter_versions SET charter = jsonb_set(charter::jsonb, '{schemaVersion}', to_jsonb('0.1'::text))
        WHERE business_id = $1`,
      [BUSINESS],
    );
    const http = fakeHttp(() => ok());
    const out = await scan(http, T0);
    expect(out.scanned).toBe(0);
    expect(out.warnings.join(' ')).toContain('charter unreadable');
    expect(http.requests).toHaveLength(0);
  });
});

describe('an erased item does not come back on the next scan (I3, migration 080)', () => {
  it('the same record re-scanned after an erasure stores nothing; a changed record is stored', async () => {
    await install();
    await connect();
    expect(await scan(fakeHttp(() => ok()), T0)).toMatchObject({ newItems: 2 });

    const plan = await withBusiness(BUSINESS, (db) => buildErasurePlan(db, { kind: 'contact', identifier: 'dana@x.example' }));
    expect(plan.externalEventIds).toHaveLength(1);
    await withBusiness(BUSINESS, (db) => executeErasure(db, plan));
    expect((await events()).map((r) => r.fields[0]?.value)).toEqual(['רון לוי']);

    const again = await scan(fakeHttp(() => ok()), new Date(T0.getTime() + 24 * HOUR));
    expect(again).toMatchObject({ scanned: 1, newItems: 0 });
    expect((await events()).map((r) => r.fields[0]?.value)).toEqual(['רון לוי']);

    const changed = JSON.stringify({ data: [{ id: 'c1', name: 'דנה כהן', email: 'dana.new@x.example' }] });
    const later = await scan(fakeHttp(() => ok(changed)), new Date(T0.getTime() + 48 * HOUR));
    expect(later).toMatchObject({ scanned: 1, newItems: 1 });
    expect((await events()).map((r) => r.fields[1]?.value)).toEqual(['ron@x.example', 'dana.new@x.example']);
  });
});
