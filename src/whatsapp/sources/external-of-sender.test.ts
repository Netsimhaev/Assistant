import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../../charter/store.js';
import { closePool, withBusiness } from '../../db/pool.js';
import { putSecret, storedCredentials } from '../../governance/credential-store.js';
import { writeKeyState } from '../../governance/master-key.js';
import type { ExternalHttp, ExternalRequest, ExternalResult } from '../../external/http.js';
import { upsertBinding } from '../../orchestrator/bindings.js';
import { crmConnection, crmFixture, type ExternalSystemInput } from '../../test/external-fixtures.js';
import { buildCharter } from '../../test/fixtures.js';
import { registerBusiness, resetDatabase, testDb } from '../../test/db.js';
import { TEST_MASTER_KEY } from '../../test/owner.js';
import { createExternalOfSenderSource } from './external-of-sender.js';
import { INVOICE_SETTINGS_REFUSALS, saveExternalSources } from './invoice-settings.js';

const BUSINESS = 'ext-sender-shop';

function system(): ExternalSystemInput {
  const crm = crmFixture();
  const common = {
    kind: 'read' as const,
    actionClass: 'external.read' as const,
    method: 'GET' as const,
    params: [{ name: 'customer_id', in: 'query' as const, required: true }],
    idPath: 'ref',
    amount: null,
  };
  crm.operations.push(
    {
      ...common,
      name: 'list_orders',
      label: 'הזמנות',
      path: '/orders',
      fields: [
        { path: 'ref', label: 'הזמנה' },
        { path: 'customer_id', label: 'מזהה לקוח' },
      ],
    },
    {
      ...common,
      name: 'list_tickets',
      label: 'קריאות שירות',
      path: '/tickets',
      fields: [
        { path: 'ref', label: 'קריאה' },
        { path: 'customer_id', label: 'מזהה לקוח' },
      ],
    },
  );
  return crm;
}

/** Answers by path: orders and tickets can differ. */
function fakeHttp(byPath: Record<string, unknown>): ExternalHttp & { requests: ExternalRequest[] } {
  const requests: ExternalRequest[] = [];
  return {
    requests,
    send: async (req): Promise<ExternalResult> => {
      requests.push(req);
      return { kind: 'response', status: 200, body: JSON.stringify(byPath[req.url.pathname.replace('/v1', '')] ?? []) };
    },
  };
}

const SOURCES = [
  { systemId: 'crm', operation: 'list_orders', param: 'customer_id', field: 'customer_id' },
  { systemId: 'crm', operation: 'list_tickets', param: 'customer_id', field: 'customer_id' },
];

async function setup(): Promise<void> {
  await withBusiness(BUSINESS, (db) =>
    installCharter(db, buildCharter({ externalSystems: [system()], connections: [crmConnection()] })),
  );
  await withBusiness(BUSINESS, (db) =>
    upsertBinding(
      db,
      { system: 'ext:crm', status: 'live', endpoint: null, credentialRef: 'EXT_CRM_KEY', provider: null, lastOkAt: null, lastError: null },
      { by: 'test' },
    ),
  );
  await withBusiness(BUSINESS, (db) => putSecret(db, { ref: 'EXT_CRM_KEY', value: 'sk_test_key', updatedBy: 'test' }, TEST_MASTER_KEY));
  expect(await withBusiness(BUSINESS, (db) => saveExternalSources(db, SOURCES))).toEqual({ ok: true });
}

const ids = (externalIds?: Record<string, string>) => ({
  key: '972501110001',
  email: null,
  subjectKey: '+972501110001',
  ...(externalIds === undefined ? {} : { externalIds }),
});

function run(http: ExternalHttp, externalIds?: Record<string, string>) {
  const source = createExternalOfSenderSource({ http, credentials: storedCredentials(TEST_MASTER_KEY) });
  return withBusiness(BUSINESS, (db) => source(db, ids(externalIds), new AbortController().signal, { window: null, timeZone: 'Asia/Jerusalem' }));
}

beforeEach(async () => {
  await resetDatabase();
  await registerBusiness(BUSINESS);
  await writeKeyState(TEST_MASTER_KEY, 'KEY-test', testDb());
});
afterAll(async () => {
  await closePool();
});

describe('createExternalOfSenderSource', () => {
  it("runs every configured source and labels items by the signed operation's label", async () => {
    await setup();
    const http = fakeHttp({
      '/orders': [{ ref: 'O-1', customer_id: 'C-7' }],
      '/tickets': [{ ref: 'T-1', customer_id: 'C-7' }],
    });
    const out = await run(http, { crm: 'C-7' });
    expect(out.ownershipViolation).toBe(false);
    expect(out.items.map((i) => [i.source, i.label])).toEqual([
      ['external_of_sender', 'הזמנות'],
      ['external_of_sender', 'קריאות שירות'],
    ]);
    expect(out.items[0]?.text).toBe('הזמנה: O-1\nמזהה לקוח: C-7');
    expect(http.requests).toHaveLength(2);
  });

  it('a foreign row in the second source voids the whole result', async () => {
    await setup();
    const http = fakeHttp({
      '/orders': [{ ref: 'O-1', customer_id: 'C-7' }],
      '/tickets': [{ ref: 'T-9', customer_id: 'C-70' }],
    });
    const out = await run(http, { crm: 'C-7' });
    expect(out).toEqual({ items: [], ownershipViolation: true });
    expect(http.requests).toHaveLength(2);
  });

  it('a contact without an id in the system makes no HTTP call', async () => {
    await setup();
    const http = fakeHttp({ '/orders': [{ ref: 'O-1', customer_id: 'C-7' }] });
    const out = await run(http, { other: 'X-1' });
    expect(out).toEqual({ items: [], ownershipViolation: false });
    expect(http.requests).toHaveLength(0);
  });

  it('skips at run time an operation that is no longer signed after the charter changed', async () => {
    await setup();
    await withBusiness(BUSINESS, (db) =>
      installCharter(db, buildCharter({ version: 'v2', externalSystems: [crmFixture()], connections: [crmConnection()] })),
    );
    const http = fakeHttp({ '/orders': [{ ref: 'O-1', customer_id: 'C-7' }] });
    const out = await run(http, { crm: 'C-7' });
    expect(out.items).toEqual([]);
    expect(out.ownershipViolation).toBe(false);
    expect(http.requests).toHaveLength(0);
  });

  it('caps rows at ten per source', async () => {
    await setup();
    const many = Array.from({ length: 14 }, (_, i) => ({ ref: `O-${i}`, customer_id: 'C-7' }));
    const out = await run(fakeHttp({ '/orders': many }), { crm: 'C-7' });
    expect(out.items.filter((i) => i.label === 'הזמנות')).toHaveLength(10);
  });
});

describe('saveExternalSources refusals', () => {
  it('refuses an operation that is not a signed read', async () => {
    await setup();
    const unknown = await withBusiness(BUSINESS, (db) =>
      saveExternalSources(db, [{ systemId: 'crm', operation: 'nope', param: 'customer_id', field: 'customer_id' }]),
    );
    expect(unknown).toEqual({ ok: false, error: INVOICE_SETTINGS_REFUSALS.unknownOperation });
    const notRead = await withBusiness(BUSINESS, (db) =>
      saveExternalSources(db, [{ systemId: 'crm', operation: 'update_customer', param: 'customer_id', field: 'customer_id' }]),
    );
    expect(notRead.ok).toBe(false);
  });
});
