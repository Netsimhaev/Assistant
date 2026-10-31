import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { activeCharterVersion, installCharter } from '../charter/store.js';
import { emailDomainProblemHe } from '../domain/charter.js';
import { loadDraft, saveSection } from '../charter/interview/draft-store.js';
import { completeAnswers } from '../charter/interview/test-answers.js';
import type { AcceptedRule } from '../charter/interview/answers.js';
import type { RuleProposer } from '../charter/interview/rule-proposal.js';
import { loadAutonomyMode, setAutonomyMode } from '../governance/autonomy-mode.js';
import { NO_CHANGES_NOTE } from '../charter/interview/summary.js';
import { MAILBOX_AUTHORISATION_TEXT, PREFLIGHT_REFUSAL_TITLE, RESTART_NOTE } from './mailbox-connect.js';
import { escapeHtml } from './views.js';
import { createOwner } from './auth.js';
import { createServer } from './server.js';

const BUSINESS = 'setup-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';

let server: Server | null = null;

beforeEach(async () => {
  await resetDatabase();
  await createOwner({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
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

async function startServer(ruleProposer?: RuleProposer): Promise<string> {
  server = createServer({ businessId: BUSINESS, port: 0, ...(ruleProposer ? { ruleProposer } : {}) });
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    body: new URLSearchParams({ username: USERNAME, password: PASSWORD }),
    redirect: 'manual',
  });
  const pair = (res.headers.get('set-cookie') ?? '').split(';')[0];
  if (!pair) throw new Error('no session cookie');
  return pair;
}

/** The `ruleHash` on the buttons of rule `index` (every button of a rule carries the same one). */
function ruleHashOf(html: string, index: number): string {
  const re = new RegExp(String.raw`action="/setup/rule/${index}"[\s\S]*?name="ruleHash" value="([0-9a-f]+)"`);
  const match = re.exec(html);
  if (!match?.[1]) throw new Error(`no ruleHash for rule ${index}`);
  return match[1];
}

function csrfOf(html: string): string {
  const match = /name="csrf" value="([0-9a-f]+)"/.exec(html);
  if (!match?.[1]) throw new Error(`no csrf in: ${html.slice(0, 200)}`);
  return match[1];
}

async function get(baseUrl: string, cookie: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: 'manual' });
}

async function csrfFor(baseUrl: string, cookie: string, path = '/setup/step/1'): Promise<string> {
  return csrfOf(await (await get(baseUrl, cookie, path)).text());
}

async function post(baseUrl: string, cookie: string, path: string, fields: Record<string, string | string[]>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { cookie }, body, redirect: 'manual' });
}

/** A complete interview, one form per step, in the shape the screens post. */
function stepForms(): Record<number, Record<string, string | string[]>> {
  return {
    1: {
      description: 'מספרה לגברים בחולון, לקוחות מכל הגילים שבאים לתספורת וגילוח',
      legalName: 'דוגמה תספורות בע"מ',
      tradeName: 'דוגמה תספורות',
      vertical: 'מספרה',
      employees: '3',
      expectations: 'לקבוע תורים, לענות ללקוחות במייל ולהזכיר להם על התור מראש',
      notDone: 'צביעת שיער',
      kf0_q: 'יש חניה?',
      kf0_a: 'כן, ברחוב.',
    },
    2: { displayName: 'דנה לוי', role: 'בעלים', whatsapp: '+972541234567', email: 'dana@example.co.il' },
    3: { register: 'warm', signOff: 'תודה, דנה', emojiPolicy: 'sparingly', mustNeverSay: 'מובטח' },
    4: {
      workweek: ['sun', 'mon', 'tue', 'wed', 'thu'],
      open: '09:00',
      close: '19:00',
      quietFrom: '21:00',
      quietTo: '08:00',
      timezone: 'Asia/Jerusalem',
    },
    5: { mailbox: 'none', documents: 'no' },
    6: { 'row:email.reply': 'alone', 'row:quote.issue': 'approve' },
    7: { single: '1000', daily: '3000', monthly: '20000', discount: '5' },
    8: { known0_label: 'ספק מוצרים', known0_emailDomain: 'supplier.co.il', dnc0_label: 'מתחרה', dnc0_phone: '+972501112233' },
    9: { mode: 'ask' },
    10: {},
  };
}

describe('the no-charter gate', () => {
  it('redirects every page to /setup while there is no charter', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    for (const path of ['/', '/connections', '/autonomy', '/mail']) {
      const res = await get(baseUrl, cookie, path);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/setup');
    }
  });

  it('does not redirect once a charter is active', async () => {
    await installCharter(buildCharter(), { businessId: BUSINESS });
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await get(baseUrl, cookie, '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/setup/edit"');
  });
});

describe('the interview steps', () => {
  it('resumes at the first unanswered step', async () => {
    const answers = completeAnswers();
    await saveSection(BUSINESS, 'business', answers.business);
    await saveSection(BUSINESS, 'principal', answers.principal);
    await saveSection(BUSINESS, 'voice', answers.voice);
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await get(baseUrl, cookie, '/setup');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/setup/step/4');
  });

  it('pre-fills step 4 with Asia/Jerusalem and Sun–Thu', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const body = await (await get(baseUrl, cookie, '/setup/step/4')).text();
    expect(body).toContain('value="Asia/Jerusalem"');
    expect(body).toContain('value="thu" checked');
    expect(body).not.toContain('value="fri" checked');
  });

  it('re-renders step 8 with the domain error', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const csrf = await csrfFor(baseUrl, cookie, '/setup/step/8');
    const res = await post(baseUrl, cookie, '/setup/step/8', {
      csrf,
      known0_label: 'מתחרה',
      known0_emailDomain: '*.rival.co.il',
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain(escapeHtml(emailDomainProblemHe('*.rival.co.il') ?? 'missing'));
    expect(body).toContain('כתבו &quot;rival.co.il&quot; במקום');
    // What was typed is shown back.
    expect(body).toContain('value="*.rival.co.il"');
    expect((await loadDraft(BUSINESS))?.answers.counterparties).toBeUndefined();
  });

  it('shows the "domain or phone" issue next to the entry', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const csrf = await csrfFor(baseUrl, cookie, '/setup/step/8');
    const res = await post(baseUrl, cookie, '/setup/step/8', { csrf, known0_label: 'לקוח בלי פרטים' });
    expect(res.status).toBe(400);
    const body = await res.text();
    const row = body.indexOf('value="לקוח בלי פרטים"');
    const issue = body.indexOf('יש למלא דומיין מייל או מספר טלפון', row);
    expect(row).toBeGreaterThan(-1);
    expect(issue).toBeGreaterThan(row);
  });

  it('step 6 cannot post alone for quote.issue', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const csrf = await csrfFor(baseUrl, cookie, '/setup/step/6');
    const res = await post(baseUrl, cookie, '/setup/step/6', { csrf, 'row:quote.issue': 'alone' });
    expect(res.status).toBe(400);
    expect((await loadDraft(BUSINESS))?.answers.actions).toBeUndefined();
  });

  it('a time zone it does not know is refused in Hebrew', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const csrf = await csrfFor(baseUrl, cookie, '/setup/step/4');
    const res = await post(baseUrl, cookie, '/setup/step/4', { ...stepForms()[4], csrf, timezone: 'Mars/Olympus' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('אזור הזמן אינו מוכר');
  });

  it('step 7 is skipped and saves zeros when every money row is "never"', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const page = await (await get(baseUrl, cookie, '/setup/step/7')).text();
    expect(page).toContain('בחרת שאני לא נוגעת בכסף');
    const res = await post(baseUrl, cookie, '/setup/step/7', { csrf: csrfOf(page), single: '999' });
    expect(res.status).toBe(303);
    expect((await loadDraft(BUSINESS))?.answers.money).toEqual({
      singleMinor: 0,
      dailyMinor: 0,
      monthlyMinor: 0,
      maxDiscountPercent: 0,
    });
  });

  it('asks once for more under a short open answer in step 1', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const csrf = await csrfFor(baseUrl, cookie);
    const res = await post(baseUrl, cookie, '/setup/step/1', { ...stepForms()[1], csrf, description: 'מספרה' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/setup/step/1?more=1');
    const again = await (await get(baseUrl, cookie, '/setup/step/1?more=1')).text();
    expect(again).toContain('name="followed" value="1"');
    const second = await post(baseUrl, cookie, '/setup/step/1', {
      ...stepForms()[1],
      csrf: csrfOf(again),
      description: 'מספרה',
      followed: '1',
    });
    expect(second.headers.get('location')).toBe('/setup/step/2');
  });

  it('rejects a POST without CSRF', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await post(baseUrl, cookie, '/setup/step/2', stepForms()[2] ?? {});
    expect(res.status).toBe(403);
    expect(await loadDraft(BUSINESS)).toBeNull();
  });
});

describe('stage 10', () => {
  it('rule proposal goes through the injected proposer and is accepted by index', async () => {
    const calls: string[] = [];
    const proposer: RuleProposer = async (text) => {
      calls.push(text);
      return { kind: 'forbid', text, actionClasses: ['media.publish'] } satisfies AcceptedRule;
    };
    const baseUrl = await startServer(proposer);
    const cookie = await login(baseUrl);
    const csrf = await csrfFor(baseUrl, cookie, '/setup/step/10');

    const proposed = await post(baseUrl, cookie, '/setup/rule', { csrf, text: 'לעולם לא לפרסם מחירים' });
    expect(proposed.status).toBe(303);
    expect(calls).toEqual(['לעולם לא לפרסם מחירים']);
    expect((await loadDraft(BUSINESS))?.answers.extra?.pending).toHaveLength(1);

    const page = await (await get(baseUrl, cookie, '/setup/step/10')).text();
    expect(page).toContain('נכון?');
    // The form names an index only; any rule fields it smuggles are ignored.
    const chosen = await post(baseUrl, cookie, '/setup/rule/0', {
      csrf: csrfOf(page),
      ruleHash: ruleHashOf(page, 0),
      choice: 'accept',
      kind: 'forbid',
      actionClasses: 'purchase.place',
    });
    expect(chosen.status).toBe(303);
    const extra = (await loadDraft(BUSINESS))?.answers.extra;
    expect(extra?.pending).toEqual([]);
    expect(extra?.accepted).toEqual([{ kind: 'forbid', text: 'לעולם לא לפרסם מחירים', actionClasses: ['media.publish'] }]);
  });

  it('a choice repeated on a shifted index is refused and the other rule is untouched', async () => {
    const baseUrl = await startServer(async (text) => ({ kind: 'guidance', text }));
    const cookie = await login(baseUrl);
    const csrf = await csrfFor(baseUrl, cookie, '/setup/step/10');
    await post(baseUrl, cookie, '/setup/rule', { csrf, text: 'ראשון' });
    await post(baseUrl, cookie, '/setup/rule', { csrf, text: 'שני' });
    const page = await (await get(baseUrl, cookie, '/setup/step/10')).text();
    const choice = { csrf, ruleHash: ruleHashOf(page, 0), choice: 'delete' };

    // A double click: the same form, posted twice.
    expect((await post(baseUrl, cookie, '/setup/rule/0', choice)).status).toBe(303);
    const second = await post(baseUrl, cookie, '/setup/rule/0', choice);
    expect(second.status).toBe(409);
    expect(await second.text()).toContain('לא בוצעה כל פעולה');

    expect((await loadDraft(BUSINESS))?.answers.extra).toEqual({
      accepted: [],
      pending: [{ kind: 'guidance', text: 'שני' }],
    });
  });

  it('refuses a choice without the rule hash', async () => {
    const baseUrl = await startServer(async (text) => ({ kind: 'guidance', text }));
    const cookie = await login(baseUrl);
    const csrf = await csrfFor(baseUrl, cookie, '/setup/step/10');
    await post(baseUrl, cookie, '/setup/rule', { csrf, text: 'ראשון' });
    const res = await post(baseUrl, cookie, '/setup/rule/0', { csrf, choice: 'accept' });
    expect(res.status).toBe(409);
    expect((await loadDraft(BUSINESS))?.answers.extra?.pending).toHaveLength(1);
  });

  it('refuses a sentence over 500 characters before calling the proposer', async () => {
    let called = false;
    const baseUrl = await startServer(async (text) => {
      called = true;
      return { kind: 'guidance', text };
    });
    const cookie = await login(baseUrl);
    const csrf = await csrfFor(baseUrl, cookie, '/setup/step/10');
    const res = await post(baseUrl, cookie, '/setup/rule', { csrf, text: 'א'.repeat(501) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('ארוך מדי');
    expect(called).toBe(false);
  });

  it('"guidance" keeps only the sentence, as guidance', async () => {
    const baseUrl = await startServer(async (text) => ({ kind: 'never_say', text, phrase: 'זול' }));
    const cookie = await login(baseUrl);
    const csrf = await csrfFor(baseUrl, cookie, '/setup/step/10');
    await post(baseUrl, cookie, '/setup/rule', { csrf, text: 'לא להגיד שאנחנו זולים' });
    const page = await (await get(baseUrl, cookie, '/setup/step/10')).text();
    await post(baseUrl, cookie, '/setup/rule/0', { csrf, ruleHash: ruleHashOf(page, 0), choice: 'guidance' });
    expect((await loadDraft(BUSINESS))?.answers.extra?.accepted).toEqual([
      { kind: 'guidance', text: 'לא להגיד שאנחנו זולים' },
    ]);
  });
});

async function completeViaPosts(baseUrl: string, cookie: string): Promise<void> {
  const forms = stepForms();
  for (let step = 1; step <= 10; step += 1) {
    const csrf = await csrfFor(baseUrl, cookie, `/setup/step/${step}`);
    const res = await post(baseUrl, cookie, `/setup/step/${step}`, { ...(forms[step] ?? {}), csrf });
    expect(res.status, `step ${step}: ${res.status === 400 ? await res.text() : ''}`).toBe(303);
  }
}

describe('summary and sign', () => {
  it('escapes typed names on the summary', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    await completeViaPosts(baseUrl, cookie);
    const csrf = await csrfFor(baseUrl, cookie, '/setup/step/1');
    const res = await post(baseUrl, cookie, '/setup/step/1', {
      ...stepForms()[1],
      csrf,
      tradeName: '<b>‮x',
      followed: '1',
    });
    expect(res.status).toBe(303);

    const body = await (await get(baseUrl, cookie, '/setup/summary')).text();
    expect(body).toContain('&lt;b&gt;x');
    expect(body).not.toContain('<b>‮');
    expect(body).not.toContain('‮');
  });

  it('sign end-to-end', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    await completeViaPosts(baseUrl, cookie);

    const summary = await get(baseUrl, cookie, '/setup/summary');
    expect(summary.status).toBe(200);
    const html = await summary.text();
    expect(html).toContain('חתום והתחל');
    const shownHash = /name="shownHash" value="([0-9a-f]+)"/.exec(html)?.[1];
    expect(shownHash).toBeDefined();

    const res = await post(baseUrl, cookie, '/setup/sign', { csrf: csrfOf(html), shownHash: shownHash ?? '' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(await activeCharterVersion(BUSINESS)).not.toBeNull();
    expect(await loadAutonomyMode({ businessId: BUSINESS })).toBe('ask');
    expect((await get(baseUrl, cookie, '/')).status).toBe(200);
  });

  it('refuses a sign whose hash is not the one shown, in Hebrew', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    await completeViaPosts(baseUrl, cookie);
    const html = await (await get(baseUrl, cookie, '/setup/summary')).text();
    const res = await post(baseUrl, cookie, '/setup/sign', { csrf: csrfOf(html), shownHash: 'f'.repeat(64) });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('href="/setup/summary"');
    expect(await activeCharterVersion(BUSINESS)).toBeNull();
  });

  it('sends an incomplete draft from the summary back to /setup', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await get(baseUrl, cookie, '/setup/summary');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/setup');
  });

  it('shows the banner on / when the dial could not be applied', async () => {
    await installCharter(buildCharter(), { businessId: BUSINESS });
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const body = await (await get(baseUrl, cookie, '/?mode=failed')).text();
    expect(body).toContain('רמת החופש שבחרת לא הוחלה');
  });
});

describe('edit the rules', () => {
  it('prefills from the active charter and opens step 1', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    await completeViaPosts(baseUrl, cookie);
    const html = await (await get(baseUrl, cookie, '/setup/summary')).text();
    const shownHash = /name="shownHash" value="([0-9a-f]+)"/.exec(html)?.[1] ?? '';
    await post(baseUrl, cookie, '/setup/sign', { csrf: csrfOf(html), shownHash });
    const active = await activeCharterVersion(BUSINESS);

    const res = await get(baseUrl, cookie, '/setup/edit');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/setup/step/1');
    const draft = await loadDraft(BUSINESS);
    expect(draft?.baseCharterVersion).toBe(active);
    expect(draft?.answers.business?.tradeName).toBe('דוגמה תספורות');
    // `autonomy` is not in the charter: /setup resumes there.
    const resume = await get(baseUrl, cookie, '/setup');
    expect(resume.headers.get('location')).toBe('/setup/step/9');
  });

  it('opens an empty interview with a notice over an unreadable charter', async () => {
    await installCharter(buildCharter({ version: 'broken-1' }), { businessId: BUSINESS });
    await getPool().query(
      `UPDATE charter_versions
          SET charter = jsonb_set(charter::jsonb, '{schemaVersion}', to_jsonb('0'::text))
        WHERE business_id = $1`,
      [BUSINESS],
    );
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);

    // Not absent, so no redirect to /setup — the connections banner leads here.
    const connections = await get(baseUrl, cookie, '/connections');
    expect(connections.status).toBe(200);
    expect(await connections.text()).toContain('href="/setup/edit"');

    const res = await get(baseUrl, cookie, '/setup/edit');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('התקנון הקיים אינו קריא');
    const draft = await loadDraft(BUSINESS);
    expect(draft?.answers).toEqual({});
    expect(draft?.baseCharterVersion).toBe('broken-1');

    await completeViaPosts(baseUrl, cookie);
    const html = await (await get(baseUrl, cookie, '/setup/summary')).text();
    const shownHash = /name="shownHash" value="([0-9a-f]+)"/.exec(html)?.[1] ?? '';
    const sign = await post(baseUrl, cookie, '/setup/sign', { csrf: csrfOf(html), shownHash });
    expect(sign.status).toBe(303);
    expect(await activeCharterVersion(BUSINESS)).not.toBe('broken-1');
  });

  it('without an active charter, /setup/edit is the first-time interview', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await get(baseUrl, cookie, '/setup/edit');
    expect(res.headers.get('location')).toBe('/setup');
  });
});

async function signViaSummary(baseUrl: string, cookie: string): Promise<Response> {
  const html = await (await get(baseUrl, cookie, '/setup/summary')).text();
  const shownHash = /name="shownHash" value="([0-9a-f]+)"/.exec(html)?.[1] ?? '';
  return post(baseUrl, cookie, '/setup/sign', { csrf: csrfOf(html), shownHash });
}

describe('final review fixes', () => {
  it('the summary shows whose instructions I take and the known counterparties, escaped', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    await completeViaPosts(baseUrl, cookie);
    const csrf = await csrfFor(baseUrl, cookie, '/setup/step/8');
    await post(baseUrl, cookie, '/setup/step/8', {
      ...stepForms()[8],
      csrf,
      known0_label: '<i>‮ספק',
    });
    const body = await (await get(baseUrl, cookie, '/setup/summary')).text();
    expect(body).toContain('ממי אני מקבלת הוראות');
    expect(body).toContain('+972541234567');
    expect(body).toContain('dana@example.co.il');
    expect(body).toContain('לקוחות וספקים מוכרים');
    expect(body).toContain('&lt;i&gt;ספק');
    expect(body).toContain('supplier.co.il');
    expect(body).not.toContain('‮');
    expect(body).toContain('רמת החופש אחרי החתימה: <b>שואלת תמיד</b>');
  });

  it('a newly chosen mailbox puts the mailbox-signing text on the summary', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    await completeViaPosts(baseUrl, cookie);
    const csrf = await csrfFor(baseUrl, cookie, '/setup/step/5');
    await post(baseUrl, cookie, '/setup/step/5', { csrf, mailbox: 'google', documents: 'no' });
    const body = await (await get(baseUrl, cookie, '/setup/summary')).text();
    expect(body).toContain(escapeHtml(MAILBOX_AUTHORISATION_TEXT));
    expect(body).toContain(escapeHtml(RESTART_NOTE));

    const without = await (async () => {
      await post(baseUrl, cookie, '/setup/step/5', { csrf, mailbox: 'none', documents: 'no' });
      return (await get(baseUrl, cookie, '/setup/summary')).text();
    })();
    expect(without).not.toContain(escapeHtml(MAILBOX_AUTHORISATION_TEXT));
  });

  it('a sign that adds a mailbox is refused when the preflight fails, and nothing changes', async () => {
    server = createServer({ businessId: BUSINESS, port: 0, credentialKeyPath: join(tmpdir(), 'no-such-dir-xyz', 'master.key') });
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = await login(baseUrl);
    await completeViaPosts(baseUrl, cookie);
    const csrf = await csrfFor(baseUrl, cookie, '/setup/step/5');
    await post(baseUrl, cookie, '/setup/step/5', { csrf, mailbox: 'microsoft', documents: 'no' });

    const res = await signViaSummary(baseUrl, cookie);
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain(escapeHtml(PREFLIGHT_REFUSAL_TITLE));
    expect(body).toContain('לא בוצעה כל פעולה');
    expect(await activeCharterVersion(BUSINESS)).toBeNull();
    expect(await loadDraft(BUSINESS)).not.toBeNull();
  });

  it('a step with an active charter and no draft goes to /setup/edit first', async () => {
    await installCharter(buildCharter(), { businessId: BUSINESS });
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const getRes = await get(baseUrl, cookie, '/setup/step/3');
    expect(getRes.status).toBe(303);
    expect(getRes.headers.get('location')).toBe('/setup/edit');

    // The CSRF token is per session, so one rendered elsewhere is valid here.
    const csrf = csrfOf(await (await get(baseUrl, cookie, '/autonomy')).text());
    const postRes = await post(baseUrl, cookie, '/setup/step/3', { ...stepForms()[3], csrf });
    expect(postRes.status).toBe(303);
    expect(postRes.headers.get('location')).toBe('/setup/edit');
    expect(await loadDraft(BUSINESS)).toBeNull();
  });

  it('an edit: step 9 preselects the live dial, and an unchanged edit says nothing changed', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    await completeViaPosts(baseUrl, cookie);
    expect((await signViaSummary(baseUrl, cookie)).status).toBe(303);
    await setAutonomyMode('learn', USERNAME, { businessId: BUSINESS });

    await get(baseUrl, cookie, '/setup/edit');
    const step9 = await (await get(baseUrl, cookie, '/setup/step/9')).text();
    expect(step9).toContain('value="learn" checked');
    expect(step9).not.toContain('value="off" checked');

    await post(baseUrl, cookie, '/setup/step/9', { csrf: csrfOf(step9), mode: 'learn' });
    // Step 5's documents answer is not in the charter; re-confirm it as the first pass did.
    const unchanged = await (await get(baseUrl, cookie, '/setup/summary')).text();
    expect(unchanged).toContain(NO_CHANGES_NOTE);

    const csrf = await csrfFor(baseUrl, cookie, '/setup/step/2');
    await post(baseUrl, cookie, '/setup/step/2', { ...stepForms()[2], csrf, whatsapp: '+972549998877' });
    const changed = await (await get(baseUrl, cookie, '/setup/summary')).text();
    expect(changed).not.toContain(NO_CHANGES_NOTE);
    expect(changed).toContain('הוואטסאפ של הבעלים: +972541234567 ← +972549998877');
  });
});
