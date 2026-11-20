/**
 * `GET /systems` (Stage D, Task 12): the owner's summary of what the signed
 * external systems sent. Real HTTP server and Postgres.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
import { insertEvent, recordRejectedHook, recordScanAttempt } from '../external/store.js';
import { writeKeyState } from '../governance/master-key.js';
import { crmConnection, crmFixture } from '../test/external-fixtures.js';
import { buildCharter } from '../test/fixtures.js';
import { resetDatabase, testDb } from '../test/db.js';
import { createTestOwner, TEST_MASTER_KEY, loginWithSecondFactor } from '../test/owner.js';
import { createServer } from './server.js';
import { LEARNING_FAILED_TEXT, SYSTEMS_DIGEST_NOTE, scanOutcomeText } from './systems-view.js';
import { WEBHOOK_DEDUP_HINT } from '../external/describe.js';

const BUSINESS = 'test-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';
const RLO = String.fromCharCode(0x202e);

let server: Server | null = null;

beforeEach(async () => {
  await resetDatabase();
  await writeKeyState(TEST_MASTER_KEY, 'KEY-test', testDb());
  await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
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

async function start(): Promise<{ baseUrl: string; cookie: string }> {
  server = createServer({ masterKey: TEST_MASTER_KEY, port: 0, dashboardBaseUrl: 'http://127.0.0.1:4173' });
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = await loginWithSecondFactor(baseUrl, BUSINESS, { username: USERNAME, password: PASSWORD });
  return { baseUrl, cookie };
}

describe('GET /systems', () => {
  it('shows each signed system: host, last scan, counts, recent items escaped, rejected hooks', async () => {
    await withBusiness(BUSINESS, (db) =>
      installCharter(db, buildCharter({ externalSystems: [crmFixture()], connections: [crmConnection()] })),
    );
    await withBusiness(BUSINESS, async (db) => {
      await insertEvent(db, {
        systemId: 'crm',
        source: 'webhook',
        eventType: 'customer.created',
        itemHash: 'a',
        fields: [{ label: 'שם', value: `<script>x</script> דנה ${RLO}כהן` }],
      });
      await insertEvent(db, { systemId: 'crm', source: 'scan', eventType: 'list_customers', itemHash: 'b', fields: [{ label: 'שם', value: 'רון' }] });
      await recordScanAttempt(db, 'crm', { at: new Date(), outcome: 'external_auth', succeeded: false });
      await recordRejectedHook(db, 'crm', 'bad signature');
      await recordRejectedHook(db, 'crm', 'bad signature');
    });
    // One event outside 24h but inside 7d.
    await testDb().query(
      `UPDATE external_events SET created_at = now() - interval '3 days' WHERE business_id = $1 AND item_hash = 'b'`,
      [BUSINESS],
    );

    const { baseUrl, cookie } = await start();
    const res = await fetch(`${baseUrl}/systems`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('מערכת הלקוחות');
    expect(html).toContain('api.crm.example.com');
    expect(html).toContain(scanOutcomeText('external_auth'));
    expect(html).toContain('1 ב-24 השעות האחרונות · 2 ב-7 הימים האחרונים');
    expect(html).toContain('לקוח חדש — שם: &lt;script&gt;x&lt;/script&gt; דנה כהן');
    expect(html).toContain('רשימת לקוחות — שם: רון');
    expect(html).not.toContain('<script>x');
    expect(html).not.toContain(RLO);
    expect(html).toContain('התראות שנדחו (חתימה או מפתח שגויים): 2');

    // The connections page links here.
    const connections = await (await fetch(`${baseUrl}/connections`, { headers: { cookie } })).text();
    expect(connections).toContain('href="/systems"');
  });

  it('says when the last scan was cut at 200 items, and when learning failed in the last 24h', async () => {
    await withBusiness(BUSINESS, (db) =>
      installCharter(db, buildCharter({ externalSystems: [crmFixture()], connections: [crmConnection()] })),
    );
    await withBusiness(BUSINESS, (db) => recordScanAttempt(db, 'crm', { at: new Date(), outcome: 'scan_truncated', succeeded: false }));
    await testDb().query(
      `INSERT INTO external_learning_jobs (business_id, job_id, system_id, failed_at) VALUES ($1, 'J-1', 'crm', now() - interval '1 hour')`,
      [BUSINESS],
    );
    const { baseUrl, cookie } = await start();
    const html = await (await fetch(`${baseUrl}/systems`, { headers: { cookie } })).text();
    expect(html).toContain('הסריקה האחרונה החזירה יותר מ-200 פריטים — חלק לא נקלטו; כדאי לצמצם את הסריקה או להגדיר סינון לפי תאריך');
    expect(html).toContain(LEARNING_FAILED_TEXT);

    // A failure older than 24h is not shown.
    await testDb().query(`UPDATE external_learning_jobs SET failed_at = now() - interval '2 days' WHERE business_id = $1`, [BUSINESS]);
    const later = await (await fetch(`${baseUrl}/systems`, { headers: { cookie } })).text();
    expect(later).not.toContain(LEARNING_FAILED_TEXT);
  });

  it('always says the summary is also in the digest, and on this screen only when the digest is off (I4)', async () => {
    expect(SYSTEMS_DIGEST_NOTE).toBe('הסיכום ממערכות חיצוניות מופיע גם בתדריך היומי/השבועי — אם התדריך כבוי, הוא מופיע רק כאן');
    await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter({})));
    const { baseUrl, cookie } = await start();
    const off = await (await fetch(`${baseUrl}/systems`, { headers: { cookie } })).text();
    expect(off).toContain(SYSTEMS_DIGEST_NOTE);
    await testDb().query(
      `INSERT INTO digest_settings (business_id, schedule, daily_hour, weekly_day, weekly_hour, to_email, to_whatsapp, updated_by)
       VALUES ($1, 'daily', 8, 0, 8, true, false, 'test')
       ON CONFLICT (business_id) DO UPDATE SET schedule = 'daily'`,
      [BUSINESS],
    );
    const on = await (await fetch(`${baseUrl}/systems`, { headers: { cookie } })).text();
    expect(on).toContain(SYSTEMS_DIGEST_NOTE);
  });

  it('shows the dedupe hint only on a system whose webhook events declare no id-like field (M-g)', async () => {
    const withId = crmFixture();
    withId.id = 'crm2';
    withId.label = 'מערכת עם מזהה';
    withId.webhook!.events = [{ type: 'customer.created', label: 'לקוח חדש', fields: [{ path: 'data.id', label: 'מזהה' }] }];
    const withIdConnection = { ...crmConnection(), system: 'ext:crm2', label: 'מערכת עם מזהה', target: 'crm2' };
    await withBusiness(BUSINESS, (db) =>
      installCharter(
        db,
        buildCharter({ externalSystems: [crmFixture(), withId], connections: [crmConnection(), withIdConnection] }),
      ),
    );
    const { baseUrl, cookie } = await start();
    const html = await (await fetch(`${baseUrl}/systems`, { headers: { cookie } })).text();
    const cards = html.split('<div class="card">').slice(1);
    expect(cards).toHaveLength(2);
    const crm = cards.find((c) => c.includes('מערכת הלקוחות'));
    const crm2 = cards.find((c) => c.includes('מערכת עם מזהה'));
    expect(crm).toContain(WEBHOOK_DEDUP_HINT);
    expect(crm2).toBeDefined();
    expect(crm2).not.toContain(WEBHOOK_DEDUP_HINT);
  });

  it('says so when no system is signed, and sits behind the no-charter gate', async () => {
    const { baseUrl, cookie } = await start();
    const gated = await fetch(`${baseUrl}/systems`, { headers: { cookie }, redirect: 'manual' });
    expect(gated.status).toBe(303);
    expect(gated.headers.get('location')).toBe('/setup');

    await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter({})));
    const html = await (await fetch(`${baseUrl}/systems`, { headers: { cookie } })).text();
    expect(html).toContain('אין מערכות חיצוניות חתומות בתקנון');
  });

  it('never shows a stored outcome code raw', () => {
    expect(scanOutcomeText('ok')).toBe('הצליחה');
    expect(scanOutcomeText('<b>weird</b>')).toBe('תוצאה לא מוכרת');
    expect(scanOutcomeText('toString')).toBe('תוצאה לא מוכרת');
  });

  it('requires a session', async () => {
    await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter({})));
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/systems`, { redirect: 'manual' });
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get('location')).not.toBe('/systems');
  });
});
