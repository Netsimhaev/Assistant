import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../../db/pool.js';
import { resetDatabase, TEST_BUSINESS, testDb } from '../../test/db.js';
import { ledgerOfSender } from './ledger-of-sender.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

async function seed(id: string, over: Record<string, unknown> = {}, business = TEST_BUSINESS) {
  const row: Record<string, unknown> = {
    item_id: id, business_id: business, family: 'money_in', description: 'חשבונית 123',
    counterparty_email: 'dana@client.example', counterparty_email_verified: true,
    status: 'open', origin_job_id: 'job-x', amount_minor: 150000, ...over,
  };
  const keys = Object.keys(row);
  await testDb().query(
    `INSERT INTO ledger_items (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    keys.map((k) => row[k]),
  );
}

const ctx = { window: null, timeZone: 'Asia/Jerusalem', currency: 'ILS' };
const ids = (email: string | null) => ({ key: '972501110001', email, subjectKey: '+972501110001' });
const run = (email: string | null) =>
  withBusiness(TEST_BUSINESS, (db) => ledgerOfSender(db, ids(email), new AbortController().signal, ctx));

describe('ledgerOfSender', () => {
  it('returns a verified-email row with status and amount', async () => {
    await seed('L1');
    const out = await run('Dana@Client.example');
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ source: 'ledger_of_sender', label: 'פנקס' });
    expect(out.items[0]?.text).toContain('חשבונית 123');
    expect(out.items[0]?.text).toContain('פתוח');
    expect(out.items[0]?.text).toContain('₪1,500');
  });

  it('does not return the same email when unverified', async () => {
    await seed('L1', { counterparty_email_verified: false });
    expect((await run('dana@client.example')).items).toEqual([]);
  });

  it('does not return another email on the same domain', async () => {
    await seed('L1', { counterparty_email: 'other@client.example' });
    expect((await run('dana@client.example')).items).toEqual([]);
  });

  it('does not return closed rows or another business', async () => {
    await seed('L1', { status: 'done' });
    await seed('L2', {}, 'other-biz');
    expect((await run('dana@client.example')).items).toEqual([]);
  });

  it('returns a stuck row labelled as stuck', async () => {
    await seed('L1', { status: 'stuck' });
    expect((await run('dana@client.example')).items[0]?.text).toContain('תקוע');
  });

  it('returns at most 10 rows', async () => {
    for (let i = 0; i < 12; i += 1) await seed(`L${i}`);
    expect((await run('dana@client.example')).items).toHaveLength(10);
  });

  it('is empty when the sender has no email', async () => {
    await seed('L1');
    expect((await run(null)).items).toEqual([]);
  });
});
