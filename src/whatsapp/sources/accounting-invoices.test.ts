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
import { createAccountingInvoicesSource } from './accounting-invoices.js';
import { INVOICE_SETTINGS_REFUSALS, saveInvoiceSettings } from './invoice-settings.js';

const BUSINESS = 'acct-shop';
const KEY = 'sk_test_acct_key';

function system(): ExternalSystemInput {
  const crm = crmFixture();
  crm.operations.push({
    name: 'list_invoices',
    label: 'חשבוניות',
    kind: 'read',
    actionClass: 'external.read',
    method: 'GET',
    path: '/invoices',
    params: [{ name: 'customer_id', in: 'query', required: true }],
    fields: [
      { path: 'number', label: 'מספר חשבונית' },
      { path: 'customer_id', label: 'מזהה לקוח' },
      { path: 'total', label: 'סכום' },
    ],
    idPath: 'number',
    amount: null,
  });
  return crm;
}

function fakeHttp(body: unknown): ExternalHttp & { requests: ExternalRequest[] } {
  const requests: ExternalRequest[] = [];
  return {
    requests,
    send: async (req): Promise<ExternalResult> => {
      requests.push(req);
      return { kind: 'response', status: 200, body: JSON.stringify(body) };
    },
  };
}

async function setup(opts: { configure?: boolean; connect?: boolean } = {}): Promise<void> {
  await withBusiness(BUSINESS, (db) =>
    installCharter(db, buildCharter({ externalSystems: [system()], connections: [crmConnection()] })),
  );
  if (opts.connect !== false) {
    await withBusiness(BUSINESS, (db) =>
      upsertBinding(
        db,
        { system: 'ext:crm', status: 'live', endpoint: null, credentialRef: 'EXT_CRM_KEY', provider: null, lastOkAt: null, lastError: null },
        { by: 'test' },
      ),
    );
    await withBusiness(BUSINESS, (db) => putSecret(db, { ref: 'EXT_CRM_KEY', value: KEY, updatedBy: 'test' }, TEST_MASTER_KEY));
  }
  if (opts.configure !== false) {
    const saved = await withBusiness(BUSINESS, (db) =>
      saveInvoiceSettings(db, {
        systemId: 'crm',
        operation: 'list_invoices',
        customerParam: 'customer_id',
        customerField: 'customer_id',
      }),
    );
    expect(saved).toEqual({ ok: true });
  }
}

const ids = (externalIds?: Record<string, string>) => ({
  key: '972501110001',
  email: null,
  subjectKey: '+972501110001',
  ...(externalIds === undefined ? {} : { externalIds }),
});

function run(http: ExternalHttp, externalIds?: Record<string, string>) {
  const source = createAccountingInvoicesSource({ http, credentials: storedCredentials(TEST_MASTER_KEY) });
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

describe('createAccountingInvoicesSource', () => {
  it("keeps only rows carrying the contact's id", async () => {
    await setup();
    const http = fakeHttp({
      data: [
        { number: 'INV-1', customer_id: 'C-7', total: 100 },
        { number: 'INV-2', customer_id: 'C-7', total: 250 },
      ],
    });
    const out = await run(http, { crm: 'C-7' });
    expect(out.ownershipViolation).toBe(false);
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({
      source: 'accounting_invoices',
      label: 'חשבונית ממערכת הנהלת החשבונות: INV-1',
      documentId: null,
    });
    expect(out.items[0]?.text).toBe('מספר חשבונית: INV-1\nמזהה לקוח: C-7\nסכום: 100');
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.url.searchParams.get('customer_id')).toBe('C-7');
    expect(http.requests[0]?.headers['Authorization']).toBe(`Bearer ${KEY}`);
  });

  it('a foreign row sets ownershipViolation', async () => {
    await setup();
    const http = fakeHttp([
      { number: 'INV-1', customer_id: 'C-7', total: 100 },
      { number: 'INV-9', customer_id: 'C-70', total: 999 },
      { number: 'INV-10', total: 5 },
    ]);
    const out = await run(http, { crm: 'C-7' });
    expect(out.ownershipViolation).toBe(true);
    expect(out.items.map((i) => i.label)).toEqual(['חשבונית ממערכת הנהלת החשבונות: INV-1']);
    expect(JSON.stringify(out)).not.toContain('INV-9');
  });

  it('strips bidi controls and line breaks from rendered values', async () => {
    await setup();
    const out = await run(fakeHttp([{ number: 'A‮B\nC', customer_id: 'C-7', total: 1 }]), { crm: 'C-7' });
    expect(out.items[0]?.label).not.toMatch(/[‪-‮\n]/);
    expect(out.items[0]?.text.split('\n')).toHaveLength(3);
  });

  it('a response that is not a list (wrapper object) yields nothing and a violation', async () => {
    await setup();
    const http = fakeHttp({
      query: { customer_id: 'C-7' },
      customer_id: 'C-7',
      records: [{ number: 'INV-9', customer_id: 'C-70' }],
    });
    const out = await run(http, { crm: 'C-7' });
    expect(out).toEqual({ items: [], ownershipViolation: true });
  });

  it('an object or array field value is dropped and is a violation', async () => {
    await setup();
    const out = await run(
      fakeHttp([{ number: 'INV-1', customer_id: 'C-7', total: { other: [{ customer_id: 'C-70' }] } }]),
      { crm: 'C-7' },
    );
    expect(out.ownershipViolation).toBe(true);
    expect(out.items[0]?.text).toBe('מספר חשבונית: INV-1\nמזהה לקוח: C-7');
    expect(JSON.stringify(out)).not.toContain('C-70');
  });

  it('compares exactly: no trimming, numbers by String(n), other types never match', async () => {
    await setup();
    const trailing = await run(fakeHttp([{ number: 'A', customer_id: 'C-7 ', total: 1 }]), { crm: 'C-7' });
    expect(trailing).toEqual({ items: [], ownershipViolation: true });
    const num = await run(fakeHttp([{ number: 'A', customer_id: 42, total: 1 }]), { crm: '42' });
    expect(num.items).toHaveLength(1);
    expect(num.ownershipViolation).toBe(false);
    const bool = await run(fakeHttp([{ number: 'A', customer_id: true, total: 1 }]), { crm: 'true' });
    expect(bool).toEqual({ items: [], ownershipViolation: true });
  });

  it('sends no phone digits to the provider', async () => {
    await setup();
    const http = fakeHttp([{ number: 'A', customer_id: 'C-7', total: 1 }]);
    await run(http, { crm: 'C-7' });
    const req = http.requests[0];
    expect(JSON.stringify([req?.url.href, req?.headers, req?.body])).not.toContain('972501110001');
  });

  it('does nothing when the signal is already aborted', async () => {
    await setup();
    const http = fakeHttp([]);
    const source = createAccountingInvoicesSource({ http, credentials: storedCredentials(TEST_MASTER_KEY) });
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await withBusiness(BUSINESS, (db) => source(db, ids({ crm: 'C-7' }), ctrl.signal, { window: null, timeZone: 'Asia/Jerusalem' }));
    expect(out).toEqual({ items: [], ownershipViolation: false });
    expect(http.requests).toHaveLength(0);
  });

  it('no config, no externalId or no live binding → empty, no HTTP', async () => {
    const cases: { name: string; opts: { configure?: boolean; connect?: boolean }; externalIds?: Record<string, string> }[] = [
      { name: 'no config', opts: { configure: false }, externalIds: { crm: 'C-7' } },
      { name: 'no externalId', opts: {} },
      { name: 'id for another system', opts: {}, externalIds: { other: 'C-7' } },
      { name: 'no binding', opts: { connect: false }, externalIds: { crm: 'C-7' } },
    ];
    for (const c of cases) {
      await resetDatabase();
      await registerBusiness(BUSINESS);
      await writeKeyState(TEST_MASTER_KEY, 'KEY-test', testDb());
      await setup(c.opts);
      const http = fakeHttp([{ number: 'INV-1', customer_id: 'C-7' }]);
      const out = await run(http, c.externalIds);
      expect(out, c.name).toEqual({ items: [], ownershipViolation: false });
      expect(http.requests, c.name).toHaveLength(0);
    }
  });
});

describe('saveInvoiceSettings', () => {
  it('refuses an operation that is not kind read in the active charter', async () => {
    await setup({ configure: false });
    const base = { systemId: 'crm', customerParam: 'customer_id', customerField: 'customer_id' };
    const change = await withBusiness(BUSINESS, (db) => saveInvoiceSettings(db, { ...base, operation: 'update_customer' }));
    expect(change).toEqual({ ok: false, error: INVOICE_SETTINGS_REFUSALS.notRead });
    const unknownSystem = await withBusiness(BUSINESS, (db) =>
      saveInvoiceSettings(db, { ...base, systemId: 'nope', operation: 'list_invoices' }),
    );
    expect(unknownSystem).toEqual({ ok: false, error: INVOICE_SETTINGS_REFUSALS.unknownSystem });
    const badParam = await withBusiness(BUSINESS, (db) =>
      saveInvoiceSettings(db, { ...base, operation: 'list_invoices', customerParam: 'zzz' }),
    );
    expect(badParam).toEqual({ ok: false, error: INVOICE_SETTINGS_REFUSALS.unknownParam });
    const badField = await withBusiness(BUSINESS, (db) =>
      saveInvoiceSettings(db, { ...base, operation: 'list_invoices', customerField: 'secret' }),
    );
    expect(badField).toEqual({ ok: false, error: INVOICE_SETTINGS_REFUSALS.unknownField });
    const indexed = await withBusiness(BUSINESS, (db) =>
      saveInvoiceSettings(db, { ...base, operation: 'list_invoices', customerField: 'rows.0.customer_id' }),
    );
    expect(indexed).toEqual({ ok: false, error: INVOICE_SETTINGS_REFUSALS.indexedField });
    const { rows } = await testDb().query(`SELECT 1 FROM contact_whatsapp_settings WHERE business_id = $1`, [BUSINESS]);
    expect(rows).toHaveLength(0);
  });
});
