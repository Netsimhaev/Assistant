import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../../db/pool.js';
import { resetDatabase, TEST_BUSINESS, testDb } from '../../test/db.js';
import { meetingsOfSender } from './meetings-of-sender.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

let n = 0;
async function seed(over: Record<string, unknown> = {}) {
  n += 1;
  const row: Record<string, unknown> = {
    meeting_id: `M${n}`, business_id: TEST_BUSINESS, job_id: 'job-x', step_id: `s${n}`, calendar_id: 'primary',
    event_id: `ev${n}`, operation: 'create', client_name: 'דנה', client_phone: '+972 50-111-0001',
    client_email: null, state: 'active', response: 'accepted',
    start_at: new Date(Date.now() + 2 * 86400_000).toISOString(), ...over,
  };
  const keys = Object.keys(row);
  await testDb().query(
    `INSERT INTO meetings (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    keys.map((k) => row[k]),
  );
}

const ctx = { window: null, timeZone: 'Asia/Jerusalem' };
const run = (email: string | null = null) =>
  withBusiness(TEST_BUSINESS, (db) =>
    meetingsOfSender(db, { key: '972501110001', email, subjectKey: '+972501110001' }, new AbortController().signal, ctx),
  );

describe('meetingsOfSender', () => {
  it('matches a formatted stored phone against the digits key', async () => {
    await seed();
    const out = await run();
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ source: 'meetings_of_sender', label: 'פגישות' });
    expect(out.items[0]?.text).toContain('אישר');
  });

  it('matches by email, case-insensitively', async () => {
    await seed({ client_phone: null, client_email: 'Dana@client.example' });
    expect((await run('dana@client.example')).items).toHaveLength(1);
  });

  it('skips a meeting from 2 days ago, abandoned ones and other people', async () => {
    await seed({ start_at: new Date(Date.now() - 2 * 86400_000).toISOString() });
    await seed({ state: 'abandoned' });
    await seed({ client_phone: '+972 50-222-0002' });
    expect((await run()).items).toEqual([]);
  });
});
