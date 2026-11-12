/**
 * The ledger screens: `/ledger` (list + owner actions) and `/ledger/settings`
 * (modes, channels, numbers, critical rules). Real HTTP server and Postgres.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool, withBusiness } from '../db/pool.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { resetDatabase } from '../test/db.js';
import { createLedgerItem, listLedgerEvents, loadLedgerItem, type NewLedgerItem } from '../ledger/store.js';
import { listCriticalRules, loadLedgerSettings } from '../ledger/settings.js';
import { localParts, localToInstant } from '../util/local-time.js';
import { createTestOwner, ownerLogin } from '../test/owner.js';
import { createServer } from './server.js';

const BUSINESS = 'test-business';
const OTHER = 'other-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';

let server: Server | null = null;

beforeEach(async () => {
  await resetDatabase();
  await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
  await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ version: 'gate-charter' })));
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

async function start(): Promise<string> {
  server = createServer({ port: 0 });
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    body: new URLSearchParams({ email: ownerLogin(BUSINESS, USERNAME), password: PASSWORD }),
    redirect: 'manual',
  });
  const pair = (res.headers.get('set-cookie') ?? '').split(';')[0];
  if (!pair) throw new Error('no session cookie');
  return pair;
}

async function get(baseUrl: string, cookie: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: 'manual' });
}

async function csrfOf(baseUrl: string, cookie: string, path = '/ledger/settings'): Promise<string> {
  const html = await (await get(baseUrl, cookie, path)).text();
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  if (!m?.[1]) throw new Error('no csrf token on ' + path);
  return m[1];
}

async function post(
  baseUrl: string,
  cookie: string,
  path: string,
  fields: Record<string, string>,
  csrf?: string,
): Promise<Response> {
  const body = new URLSearchParams(fields);
  if (csrf !== undefined) body.set('csrf', csrf);
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { cookie }, body, redirect: 'manual' });
}

function item(over: Partial<NewLedgerItem> = {}): NewLedgerItem {
  return {
    family: 'money_in',
    description: 'חשבונית 123',
    dueAt: new Date('2099-12-01T10:00:00Z'),
    dueIsDateOnly: false,
    importance: 'normal',
    importanceManual: false,
    counterpartyName: 'דנה',
    counterpartyEmail: null,
    counterpartyEmailVerified: false,
    counterpartyDomain: null,
    reference: null,
    amountMinor: null,
    stages: [],
    proposedStages: null,
    originJobId: 'job-1',
    ...over,
  };
}

/** Settings form fields as the page would submit them (the money_out radio is disabled, so it is absent). */
function settingsFields(over: Record<string, string> = {}): Record<string, string> {
  return {
    mode_money_in: 'remind',
    mode_meetings: 'remind',
    mode_warm_leads: 'remind',
    mode_awaiting_reply: 'remind',
    mode_projects: 'remind',
    toEmail: 'on',
    toScreen: 'on',
    meetingLeadMinutes: '60',
    meetingLeadMinutesCritical: '1440,60',
    dueLeadDaysCritical: '3',
    nudgeAfterBusinessDays: '3',
    checkinEveryDays: '2',
    checkinEveryDaysCritical: '1',
    dailyHour: '8',
    ...over,
  };
}

describe('GET /ledger', () => {
  it('lists open items with the stuck list first', async () => {
    await withBusiness(BUSINESS, (db) => createLedgerItem(db, item({ description: 'פריט רגיל פתוח' }), { by: 'boss' }));
    const stuck = await withBusiness(BUSINESS, (db) => createLedgerItem(db, item({ description: 'פריט תקוע דחוף' }), { by: 'boss' }));
    await getPool().query(`UPDATE ledger_items SET status = 'stuck' WHERE item_id = $1`, [stuck.itemId]);
    const base = await start();
    const cookie = await login(base);
    const res = await get(base, cookie, '/ledger');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('רשימת התקוע');
    expect(html).toContain('פריט תקוע דחוף');
    expect(html).toContain('פריט רגיל פתוח');
    expect(html.indexOf('רשימת התקוע')).toBeLessThan(html.indexOf('פריט תקוע דחוף'));
    // the stuck item is in the stuck list, ahead of the per-family sections
    expect(html.indexOf('פריט תקוע דחוף')).toBeLessThan(html.indexOf('פריט רגיל פתוח'));
  });

  it('a date-only item due TODAY is not overdue on the screen; one due yesterday is (T14)', async () => {
    const tz = 'Asia/Jerusalem'; // buildCharter's zone
    const today = localParts(new Date(), tz).date;
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
    // Stored at local midnight: already in the past by the instant, but its local date is today.
    await withBusiness(BUSINESS, (db) => createLedgerItem(db, item({ description: 'פריט שמועדו היום', dueAt: localToInstant(today, '00:00', tz), dueIsDateOnly: true }), {
      by: 'boss',
    }));
    await withBusiness(BUSINESS, (db) => createLedgerItem(
      db,
      item({ description: 'פריט שמועדו אתמול', dueAt: localToInstant(yesterday, '08:00', tz), dueIsDateOnly: true }),
      { by: 'boss' },
    ));
    const base = await start();
    const cookie = await login(base);
    const html = await (await get(base, cookie, '/ledger?filter=overdue')).text();
    expect(html).toContain('פריט שמועדו אתמול'); // the filter ran and found the real one
    expect(html).not.toContain('פריט שמועדו היום');
  });

  it('an unknown filter reads as open', async () => {
    await withBusiness(BUSINESS, (db) => createLedgerItem(db, item({ description: 'פתוח' }), { by: 'boss' }));
    const done = await withBusiness(BUSINESS, (db) => createLedgerItem(db, item({ description: 'סגור לגמרי' }), { by: 'boss' }));
    await getPool().query(`UPDATE ledger_items SET status = 'done' WHERE item_id = $1`, [done.itemId]);
    const base = await start();
    const cookie = await login(base);
    const html = await (await get(base, cookie, '/ledger?filter=bogus')).text();
    expect(html).toContain('פתוח');
    expect(html).not.toContain('סגור לגמרי');
    const all = await (await get(base, cookie, '/ledger?filter=all')).text();
    expect(all).toContain('סגור לגמרי');
  });

  it('marks unseen reminders as seen', async () => {
    const it1 = await withBusiness(BUSINESS, (db) => createLedgerItem(db, item(), { by: 'boss' }));
    await getPool().query(
      `INSERT INTO ledger_reminders (reminder_id, business_id, item_id, slot, kind, body)
       VALUES ('LR-1', $1, $2, 's1', 'due', 'x')`,
      [BUSINESS, it1.itemId],
    );
    const base = await start();
    const cookie = await login(base);
    await get(base, cookie, '/ledger');
    const { rows } = await getPool().query(`SELECT seen_at FROM ledger_reminders WHERE reminder_id = 'LR-1'`);
    expect(rows[0]?.seen_at).not.toBeNull();
  });

  describe('the follow-up line (F-I3)', () => {
    async function event(itemId: string, id: string, kind: string, at: string, jobId: string | null = null) {
      await getPool().query(
        `INSERT INTO ledger_events (event_id, business_id, item_id, kind, job_id, by_whom, at)
         VALUES ($1, $2, $3, $4, $5, 'system', $6)`,
        [id, BUSINESS, itemId, kind, jobId, at],
      );
    }
    async function reminder(itemId: string, id: string, slot: string, body: string, at: string) {
      await getPool().query(
        `INSERT INTO ledger_reminders (reminder_id, business_id, item_id, slot, kind, body, created_at)
         VALUES ($1, $2, $3, $4, 'nudge', $5, $6)`,
        [id, BUSINESS, itemId, slot, body, at],
      );
    }
    const FALLBACK_BODY = 'הגיע הזמן לחזור לדנה\n\nהכנתי טיוטה, אבל לא שלחתי (השליחה נכשלה):\nשלום דנה, רק מזכירה';

    it('an in-flight nudge reads "awaiting your approval", never as an unsent draft', async () => {
      const it1 = await withBusiness(BUSINESS, (db) => createLedgerItem(db, item({ family: 'warm_leads' }), { by: 'boss' }));
      // The opened job's claim row: no channel state (the old, wrong "draft" signal).
      await reminder(it1.itemId, 'LR-open', 'n1', 'שלום דנה, רק מזכירה', '2026-11-01T08:00:00Z');
      await getPool().query(`UPDATE ledger_items SET nudge_job_id = 'J-flight' WHERE item_id = $1`, [it1.itemId]);
      const base = await start();
      const cookie = await login(base);
      const html = await (await get(base, cookie, '/ledger')).text();
      expect(html).toContain('פולואפ ממתין לאישורך');
      expect(html).not.toContain('טיוטת פולואפ');
      expect(html).not.toContain('נשלח פולואפ');
    });

    it('a nudge that went out reads "sent", even after an earlier fallback', async () => {
      const it1 = await withBusiness(BUSINESS, (db) => createLedgerItem(db, item({ family: 'warm_leads' }), { by: 'boss' }));
      await event(it1.itemId, 'LE-f', 'nudge_fallback', '2026-11-01T08:00:00Z', 'J-old');
      await reminder(it1.itemId, 'LR-f', 'nudge_fallback:J-old', FALLBACK_BODY, '2026-11-01T08:00:00Z');
      await event(it1.itemId, 'LE-s', 'nudged', '2026-11-02T08:00:00Z', 'J-new');
      const base = await start();
      const cookie = await login(base);
      const html = await (await get(base, cookie, '/ledger')).text();
      expect(html).toContain('נשלח פולואפ');
      expect(html).not.toContain('טיוטת פולואפ');
      expect(html).not.toContain('פולואפ ממתין לאישורך');
    });

    it('the latest fallback with a draft and no later send reads "did not go out", with the draft', async () => {
      const it1 = await withBusiness(BUSINESS, (db) => createLedgerItem(db, item({ family: 'warm_leads' }), { by: 'boss' }));
      await event(it1.itemId, 'LE-s', 'nudged', '2026-11-01T08:00:00Z', 'J-old');
      await event(it1.itemId, 'LE-f', 'nudge_fallback', '2026-11-02T08:00:00Z', 'J-new');
      await reminder(it1.itemId, 'LR-f', 'nudge_fallback:J-new', FALLBACK_BODY, '2026-11-02T08:00:00Z');
      const base = await start();
      const cookie = await login(base);
      const html = await (await get(base, cookie, '/ledger')).text();
      expect(html).toContain('טיוטת פולואפ — לא יצאה לצד השני');
      expect(html).toContain('שלום דנה, רק מזכירה');
      expect(html).not.toContain('נשלח פולואפ');
    });
  });

  it('a description with a bidi override is rendered stripped', async () => {
    await withBusiness(BUSINESS, (db) => createLedgerItem(db, item({ description: 'invoice‮gpj.exe' }), { by: 'boss' }));
    const base = await start();
    const cookie = await login(base);
    const html = await (await get(base, cookie, '/ledger')).text();
    expect(html).toContain('invoicegpj.exe');
    expect(html).not.toContain('‮');
  });

  it("does not list another business's items", async () => {
    await withBusiness(OTHER, (db) => createLedgerItem(db, item({ description: 'של עסק אחר' }), { by: 'boss' }));
    await withBusiness(BUSINESS, (db) => createLedgerItem(db, item({ description: 'שלי' }), { by: 'boss' }));
    const base = await start();
    const cookie = await login(base);
    const html = await (await get(base, cookie, '/ledger')).text();
    expect(html).toContain('שלי');
    expect(html).not.toContain('של עסק אחר');
  });
});

describe('POST /ledger/:itemId/action', () => {
  it('done moves the status and records the event', async () => {
    const it1 = await withBusiness(BUSINESS, (db) => createLedgerItem(db, item(), { by: 'boss' }));
    const base = await start();
    const cookie = await login(base);
    const csrf = await csrfOf(base, cookie, '/ledger?filter=all');
    const res = await post(base, cookie, `/ledger/${it1.itemId}/action`, { action: 'done' }, csrf);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ledger');
    expect((await withBusiness(BUSINESS, (db) => loadLedgerItem(db, it1.itemId)))?.status).toBe('done');
    const kinds = (await withBusiness(BUSINESS, (db) => listLedgerEvents(db, it1.itemId))).map((e) => e.kind);
    expect(kinds).toContain('done');
  });

  it('a missing CSRF token is 403 and the status is unchanged', async () => {
    const it1 = await withBusiness(BUSINESS, (db) => createLedgerItem(db, item(), { by: 'boss' }));
    const base = await start();
    const cookie = await login(base);
    // the page renders the form, so the handler is reachable and would act with a token
    expect(await (await get(base, cookie, '/ledger')).text()).toContain(`/ledger/${it1.itemId}/action`);
    const res = await post(base, cookie, `/ledger/${it1.itemId}/action`, { action: 'done' });
    expect(res.status).toBe(403);
    expect((await withBusiness(BUSINESS, (db) => loadLedgerItem(db, it1.itemId)))?.status).toBe('open');
  });

  it("another business's item id is 404 and nothing changes", async () => {
    const foreign = await withBusiness(OTHER, (db) => createLedgerItem(db, item(), { by: 'boss' }));
    const base = await start();
    const cookie = await login(base);
    const csrf = await csrfOf(base, cookie);
    const res = await post(base, cookie, `/ledger/${foreign.itemId}/action`, { action: 'done' }, csrf);
    expect(res.status).toBe(404);
    expect((await withBusiness(OTHER, (db) => loadLedgerItem(db, foreign.itemId)))?.status).toBe('open');
  });

  it('critical sets importance and the manual flag, with an event', async () => {
    const it1 = await withBusiness(BUSINESS, (db) => createLedgerItem(db, item(), { by: 'boss' }));
    const base = await start();
    const cookie = await login(base);
    const csrf = await csrfOf(base, cookie);
    const res = await post(base, cookie, `/ledger/${it1.itemId}/action`, { action: 'critical' }, csrf);
    expect(res.status).toBe(302);
    const after = await withBusiness(BUSINESS, (db) => loadLedgerItem(db, it1.itemId));
    expect(after?.importance).toBe('critical');
    expect(after?.importanceManual).toBe(true);
    expect((await withBusiness(BUSINESS, (db) => listLedgerEvents(db, it1.itemId))).map((e) => e.kind)).toContain('updated');
  });

  it('snooze with a real date moves the due date; an impossible date is refused', async () => {
    const it1 = await withBusiness(BUSINESS, (db) => createLedgerItem(db, item(), { by: 'boss' }));
    const base = await start();
    const cookie = await login(base);
    const csrf = await csrfOf(base, cookie);
    const bad = await post(base, cookie, `/ledger/${it1.itemId}/action`, { action: 'snooze', date: '2099-02-31' }, csrf);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('תאריך');
    const before = await withBusiness(BUSINESS, (db) => loadLedgerItem(db, it1.itemId));
    expect(before?.dueAt?.toISOString()).toBe('2099-12-01T10:00:00.000Z');
    const ok = await post(base, cookie, `/ledger/${it1.itemId}/action`, { action: 'snooze', date: '2099-12-15' }, csrf);
    expect(ok.status).toBe(302);
    const after = await withBusiness(BUSINESS, (db) => loadLedgerItem(db, it1.itemId));
    expect(after?.dueAt?.getTime()).toBeGreaterThan(before?.dueAt?.getTime() ?? 0);
  });

  it('an unknown action is refused and nothing changes', async () => {
    const it1 = await withBusiness(BUSINESS, (db) => createLedgerItem(db, item(), { by: 'boss' }));
    const base = await start();
    const cookie = await login(base);
    const csrf = await csrfOf(base, cookie);
    const res = await post(base, cookie, `/ledger/${it1.itemId}/action`, { action: 'erase' }, csrf);
    expect(res.status).toBe(400);
    expect((await withBusiness(BUSINESS, (db) => loadLedgerItem(db, it1.itemId)))?.status).toBe('open');
  });

  it('an action that does not apply says so in Hebrew', async () => {
    const it1 = await withBusiness(BUSINESS, (db) => createLedgerItem(db, item({ family: 'money_in' }), { by: 'boss' }));
    const base = await start();
    const cookie = await login(base);
    const csrf = await csrfOf(base, cookie);
    const res = await post(base, cookie, `/ledger/${it1.itemId}/action`, { action: 'held' }, csrf);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('לא ניתן');
  });
});

describe('/ledger/settings', () => {
  it('renders the six families, with money_out locked', async () => {
    const base = await start();
    const cookie = await login(base);
    const html = await (await get(base, cookie, '/ledger/settings')).text();
    expect(html).toContain('רק תזכורת — אין עדיין כלי תשלום');
    expect(html).toContain('רמת החופש');
    expect(html).toMatch(/name="mode_money_out"[^>]*disabled|disabled[^>]*name="mode_money_out"/);
  });

  it('saves a valid form', async () => {
    const base = await start();
    const cookie = await login(base);
    const csrf = await csrfOf(base, cookie);
    const res = await post(base, cookie, '/ledger/settings', settingsFields({ mode_money_in: 'act', dailyHour: '9' }), csrf);
    expect(res.status).toBe(302);
    const s = await withBusiness(BUSINESS, (db) => loadLedgerSettings(db));
    expect(s.modes.money_in).toBe('act');
    expect(s.dailyHour).toBe(9);
    expect(s.modes.money_out).toBe('remind');
  });

  it("all-unchecked re-renders with the Hebrew refusal and the owner's values", async () => {
    const base = await start();
    const cookie = await login(base);
    const csrf = await csrfOf(base, cookie);
    const fields = settingsFields({ dailyHour: '11' });
    delete fields['toEmail'];
    delete fields['toScreen'];
    const res = await post(base, cookie, '/ledger/settings', fields, csrf);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('חובה לבחור לפחות דרך תזכורת אחת');
    expect(html).toMatch(/name="dailyHour"[^>]*value="11"/);
    expect((await withBusiness(BUSINESS, (db) => loadLedgerSettings(db))).dailyHour).toBe(8);
  });

  it('M3: meetings and projects are locked to remind, with the sentence; a forged act is refused', async () => {
    const base = await start();
    const cookie = await login(base);
    const html = await (await get(base, cookie, '/ledger/settings')).text();
    expect(html).toContain('בפגישות ובעבודות פתוחות אין עדיין פעולה מול הצד השני — רק תזכורת');
    for (const family of ['meetings', 'projects']) {
      expect(html).not.toMatch(new RegExp(`name="mode_${family}" value="act"`));
    }
    expect(html).toMatch(/name="mode_warm_leads" value="act"/); // the page did render act where it applies
    const csrf = await csrfOf(base, cookie);
    const res = await post(base, cookie, '/ledger/settings', settingsFields({ mode_meetings: 'act' }), csrf);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('בפגישות ובעבודות פתוחות');
    expect((await withBusiness(BUSINESS, (db) => loadLedgerSettings(db))).modes.meetings).toBe('remind');
    // A locked radio is not submitted; a form without it saves as remind.
    const fields = settingsFields({ mode_warm_leads: 'act' });
    delete fields['mode_meetings'];
    delete fields['mode_projects'];
    expect((await post(base, cookie, '/ledger/settings', fields, await csrfOf(base, cookie))).status).toBe(302);
    expect((await withBusiness(BUSINESS, (db) => loadLedgerSettings(db))).modes.warm_leads).toBe('act');
  });

  it('money_out act cannot be saved', async () => {
    const base = await start();
    const cookie = await login(base);
    const csrf = await csrfOf(base, cookie);
    const res = await post(base, cookie, '/ledger/settings', settingsFields({ mode_money_out: 'act' }), csrf);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('כסף יוצא');
    expect((await withBusiness(BUSINESS, (db) => loadLedgerSettings(db))).modes.money_out).toBe('remind');
  });

  it('an unknown mode value is refused rather than coerced', async () => {
    const base = await start();
    const cookie = await login(base);
    const csrf = await csrfOf(base, cookie);
    const res = await post(base, cookie, '/ledger/settings', settingsFields({ mode_money_in: 'bogus' }), csrf);
    expect(res.status).toBe(400);
    expect((await withBusiness(BUSINESS, (db) => loadLedgerSettings(db))).modes.money_in).toBe('remind');
  });

  it('a missing CSRF token is 403', async () => {
    const base = await start();
    const cookie = await login(base);
    const res = await post(base, cookie, '/ledger/settings', settingsFields({ dailyHour: '9' }));
    expect(res.status).toBe(403);
    expect((await withBusiness(BUSINESS, (db) => loadLedgerSettings(db))).dailyHour).toBe(8);
  });
});

describe('critical rules', () => {
  it('adds an amount rule in major units as integer minor units', async () => {
    const base = await start();
    const cookie = await login(base);
    const csrf = await csrfOf(base, cookie);
    const res = await post(base, cookie, '/ledger/rules', { kind: 'amount_over', amount: '1500.5' }, csrf);
    expect(res.status).toBe(302);
    const rules = await withBusiness(BUSINESS, (db) => listCriticalRules(db));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ kind: 'amount_over', amountMinor: 150050 });
  });

  it('refuses a fraction of an agora', async () => {
    const base = await start();
    const cookie = await login(base);
    const csrf = await csrfOf(base, cookie);
    const res = await post(base, cookie, '/ledger/rules', { kind: 'amount_over', amount: '10.005' }, csrf);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('אגורות');
    expect(await withBusiness(BUSINESS, (db) => listCriticalRules(db))).toHaveLength(0);
  });

  it('adds family and counterparty rules, then deletes one', async () => {
    const base = await start();
    const cookie = await login(base);
    const csrf = await csrfOf(base, cookie);
    await post(base, cookie, '/ledger/rules', { kind: 'family', family: 'money_in' }, csrf);
    await post(base, cookie, '/ledger/rules', { kind: 'counterparty', match: 'Acme.co.il' }, csrf);
    const rules = await withBusiness(BUSINESS, (db) => listCriticalRules(db));
    expect(rules).toHaveLength(2);
    const first = rules[0];
    if (!first) throw new Error('no rule');
    const del = await post(base, cookie, `/ledger/rules/${first.ruleId}/delete`, {}, csrf);
    expect(del.status).toBe(302);
    expect(await withBusiness(BUSINESS, (db) => listCriticalRules(db))).toHaveLength(1);
  });

  it('a rule without CSRF is 403 and writes nothing', async () => {
    const base = await start();
    const cookie = await login(base);
    const res = await post(base, cookie, '/ledger/rules', { kind: 'family', family: 'money_in' });
    expect(res.status).toBe(403);
    expect(await withBusiness(BUSINESS, (db) => listCriticalRules(db))).toHaveLength(0);
  });
});
