import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { activeCharterVersion, installCharter } from '../charter/store.js';
import { loadDraft, saveSection } from '../charter/interview/draft-store.js';
import type { DescriptionProposer } from '../business/description-proposals.js';
import { DESCRIPTION_PROPOSAL_RUNS_PER_DAY, loadActiveDescription } from '../business/description-store.js';
import { escapeHtml } from './views.js';
import { createTestOwner, ownerLogin } from '../test/owner.js';
import { createServer } from './server.js';
import { DESCRIPTION_CAP_NOTICE, DESCRIPTION_NO_DRAFT_NOTICE } from './setup-routes.js';

const BUSINESS = 'description-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';
const SENTENCE = 'לעולם לא להוציא הצעת מחיר בלי אישורי.';
const DESCRIPTION = `אנחנו מספרה בחולון. ${SENTENCE} עובדים א-ה.`;

let server: Server | null = null;

beforeEach(async () => {
  await resetDatabase();
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

function quoteProposer(calls: string[]): DescriptionProposer {
  return async (description) => {
    calls.push(description);
    return JSON.stringify([{ sentence: SENTENCE, kind: 'forbid', actionClasses: ['quote.issue'] }]);
  };
}

async function startServer(descriptionProposer?: DescriptionProposer): Promise<string> {
  server = createServer({ port: 0, ...(descriptionProposer ? { descriptionProposer } : {}) });
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

function csrfOf(html: string): string {
  const match = /name="csrf" value="([0-9a-f]+)"/.exec(html);
  if (!match?.[1]) throw new Error(`no csrf in: ${html.slice(0, 200)}`);
  return match[1];
}

async function get(baseUrl: string, cookie: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: 'manual' });
}

async function post(baseUrl: string, cookie: string, path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { cookie },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

async function install(): Promise<string> {
  await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ version: 'v-desc-1' })));
  const version = await withBusiness(BUSINESS, (bdb) => activeCharterVersion(bdb));
  if (version === null) throw new Error('no active charter');
  return version;
}

async function pointer(): Promise<unknown> {
  const { rows } = await testDb().query(`SELECT * FROM charter_active WHERE business_id = $1`, [BUSINESS]);
  return rows;
}

async function seedVersions(n: number): Promise<void> {
  for (let v = 1; v <= n; v += 1) {
    await testDb().query(
      `INSERT INTO business_descriptions (business_id, version, text, created_by) VALUES ($1, $2, $3, 'owner')`,
      [BUSINESS, v, `גרסה ${v}`],
    );
  }
}

const SETTINGS = '/settings/description';

describe('/settings/description', () => {
  it('GET shows the active description in the box (HTML-escaped, bytes kept) and a CSRF token', async () => {
    await install();
    const text = `<b>מספרה</b> שם ‮הפוך‬.`;
    await testDb().query(
      `INSERT INTO business_descriptions (business_id, version, text, created_by) VALUES ($1, 1, $2, 'owner')`,
      [BUSINESS, text],
    );
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await get(baseUrl, cookie, SETTINGS);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('תיאור העסק');
    expect(csrfOf(page)).toMatch(/^[0-9a-f]+$/);
    const shown = /<textarea name="description"[^>]*>([\s\S]*?)<\/textarea>/.exec(page)?.[1];
    expect(shown).toBe(escapeHtml(text));
    expect(page).not.toContain('<b>מספרה</b>');
  });

  it('the home page links to the settings screen', async () => {
    await install();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    expect(await (await get(baseUrl, cookie, '/')).text()).toContain(`href="${SETTINGS}">תיאור העסק</a>`);
  });

  it('POST saves a new version and lists the new proposals with the link to step 10', async () => {
    await install();
    const calls: string[] = [];
    const baseUrl = await startServer(quoteProposer(calls));
    const cookie = await login(baseUrl);
    const csrf = csrfOf(await (await get(baseUrl, cookie, SETTINGS)).text());
    const res = await post(baseUrl, cookie, SETTINGS, { csrf, description: DESCRIPTION });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(SETTINGS);
    expect(calls).toEqual([DESCRIPTION]);
    const saved = await withBusiness(BUSINESS, (bdb) => loadActiveDescription(bdb));
    expect(saved?.text).toBe(DESCRIPTION);
    expect(saved?.createdBy).toBe(USERNAME);
    const page = await (await get(baseUrl, cookie, SETTINGS)).text();
    expect(page).toContain(escapeHtml(SENTENCE));
    expect(page).toContain('href="/setup/step/10">עבור על ההצעות וחתום</a>');
  });

  it('with no open draft, POST prefills one from the active charter and its base version is the active version', async () => {
    const version = await install();
    expect(await withBusiness(BUSINESS, (bdb) => loadDraft(bdb))).toBeNull();
    const baseUrl = await startServer(quoteProposer([]));
    const cookie = await login(baseUrl);
    const csrf = csrfOf(await (await get(baseUrl, cookie, SETTINGS)).text());
    await post(baseUrl, cookie, SETTINGS, { csrf, description: DESCRIPTION });
    const draft = await withBusiness(BUSINESS, (bdb) => loadDraft(bdb));
    expect(draft?.baseCharterVersion).toBe(version);
    expect(draft?.answers.voice).toBeDefined();
    expect(draft?.answers.extra?.pending).toEqual([{ kind: 'forbid', text: SENTENCE, actionClasses: ['quote.issue'] }]);
  });

  it('with an open draft started from the active charter, proposals are appended to it, not replacing other edits', async () => {
    await install();
    const baseUrl = await startServer(quoteProposer([]));
    const cookie = await login(baseUrl);
    // Open the edit (prefill), then change something and add a pending rule.
    expect((await get(baseUrl, cookie, '/setup/edit')).status).toBe(303);
    const before = await withBusiness(BUSINESS, (bdb) => loadDraft(bdb));
    const voice = { ...(before?.answers.voice as Record<string, unknown>), signOff: 'חתימה ששונתה בעריכה' };
    await withBusiness(BUSINESS, async (bdb) => {
      await saveSection(bdb, 'voice', voice);
      await saveSection(bdb, 'extra', {
        accepted: before?.answers.extra?.accepted ?? [],
        pending: [{ kind: 'guidance', text: 'הצעה קודמת' }],
      });
    });

    const csrf = csrfOf(await (await get(baseUrl, cookie, SETTINGS)).text());
    await post(baseUrl, cookie, SETTINGS, { csrf, description: DESCRIPTION });
    const after = await withBusiness(BUSINESS, (bdb) => loadDraft(bdb));
    expect(after?.draftId).toBe(before?.draftId);
    expect(after?.answers.voice?.signOff).toBe('חתימה ששונתה בעריכה');
    expect(after?.answers.extra?.pending).toEqual([
      { kind: 'guidance', text: 'הצעה קודמת' },
      { kind: 'forbid', text: SENTENCE, actionClasses: ['quote.issue'] },
    ]);
  });

  it('the active charter is unchanged after POST until the owner signs', async () => {
    await install();
    const before = await pointer();
    const baseUrl = await startServer(quoteProposer([]));
    const cookie = await login(baseUrl);
    const csrf = csrfOf(await (await get(baseUrl, cookie, SETTINGS)).text());
    await post(baseUrl, cookie, SETTINGS, { csrf, description: DESCRIPTION });
    expect(await pointer()).toEqual(before);
  });

  it('an unreadable active charter: the description saves, no proposals, Hebrew notice, status 200', async () => {
    await install();
    await testDb().query(
      `UPDATE charter_versions
          SET charter = jsonb_set(charter::jsonb, '{schemaVersion}', to_jsonb('0'::text))
        WHERE business_id = $1`,
      [BUSINESS],
    );
    const calls: string[] = [];
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const baseUrl = await startServer(quoteProposer(calls));
    const cookie = await login(baseUrl);
    const csrf = csrfOf(await (await get(baseUrl, cookie, SETTINGS)).text());
    const res = await post(baseUrl, cookie, SETTINGS, { csrf, description: DESCRIPTION });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(escapeHtml(DESCRIPTION_NO_DRAFT_NOTICE));
    expect(calls).toEqual([]);
    expect((await withBusiness(BUSINESS, (bdb) => loadActiveDescription(bdb)))?.text).toBe(DESCRIPTION);
    expect(await withBusiness(BUSINESS, (bdb) => loadDraft(bdb))).toBeNull();
    logged.mockRestore();
  });

  it('over the daily cap: saves, no proposer call, Hebrew notice', async () => {
    await install();
    await seedVersions(DESCRIPTION_PROPOSAL_RUNS_PER_DAY);
    const calls: string[] = [];
    const baseUrl = await startServer(quoteProposer(calls));
    const cookie = await login(baseUrl);
    const csrf = csrfOf(await (await get(baseUrl, cookie, SETTINGS)).text());
    const res = await post(baseUrl, cookie, SETTINGS, { csrf, description: DESCRIPTION });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(escapeHtml(DESCRIPTION_CAP_NOTICE));
    expect(calls).toEqual([]);
    expect((await withBusiness(BUSINESS, (bdb) => loadActiveDescription(bdb)))?.text).toBe(DESCRIPTION);
  });

  it('a bad CSRF token is refused and writes nothing', async () => {
    await install();
    const calls: string[] = [];
    const baseUrl = await startServer(quoteProposer(calls));
    const cookie = await login(baseUrl);
    const res = await post(baseUrl, cookie, SETTINGS, { csrf: 'deadbeef', description: DESCRIPTION });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
    expect(await withBusiness(BUSINESS, (bdb) => loadActiveDescription(bdb))).toBeNull();
  });

  it('an unauthenticated request is redirected to login and writes nothing', async () => {
    await install();
    const calls: string[] = [];
    const baseUrl = await startServer(quoteProposer(calls));
    const getRes = await fetch(`${baseUrl}${SETTINGS}`, { redirect: 'manual' });
    expect(getRes.status).toBe(302);
    expect(getRes.headers.get('location')).toBe('/login');
    const postRes = await fetch(`${baseUrl}${SETTINGS}`, {
      method: 'POST',
      body: new URLSearchParams({ csrf: 'x', description: DESCRIPTION }),
      redirect: 'manual',
    });
    expect([302, 303, 403]).toContain(postRes.status);
    expect(calls).toEqual([]);
    expect(await withBusiness(BUSINESS, (bdb) => loadActiveDescription(bdb))).toBeNull();
  });
});
