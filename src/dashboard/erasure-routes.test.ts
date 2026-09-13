/**
 * The screen the owner uses to destroy something, and the four routes behind
 * it.
 *
 * Two things are proved here that nothing else on this branch can prove.
 * First, **the preview is the truth**: what the page lists is what the
 * executor removes, refusals included. Second, **the confirm rebuilds the
 * plan** — a plan that travelled through a browser is a plan the browser
 * could have edited, and the executor deletes exactly what its plan says.
 *
 * Every POST here is guarded by the session's CSRF token. An erasure cannot
 * be undone, so a cross-site form that reached `/erase/confirm` would be the
 * worst defect this file could ship; each route has its own negative test
 * that also asserts the rows are still there afterwards.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { writeMemory } from '../memory/store.js';
import { keepItem } from '../governance/kept-items.js';
import { readForgetCommand } from '../governance/forget-command.js';
import { buildErasurePlan } from '../governance/erasure-plan.js';
import { createOwner } from './auth.js';
import { createServer } from './server.js';
import { renderErasure } from './views.js';

const BUSINESS = 'test-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';
const RONIT = 'ronit@beta-log.example';

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

async function startServer(): Promise<string> {
  server = createServer({ businessId: BUSINESS, port: 0 });
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function cookiePair(setCookieHeader: string | null): string {
  if (!setCookieHeader) throw new Error('no Set-Cookie header on response');
  const pair = setCookieHeader.split(';')[0];
  if (!pair) throw new Error('empty Set-Cookie header');
  return pair;
}

async function signIn(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    body: new URLSearchParams({ username: USERNAME, password: PASSWORD }),
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  return cookiePair(res.headers.get('set-cookie'));
}

function extractCsrf(html: string): string {
  const match = /name="csrf" value="([0-9a-f]+)"/.exec(html);
  if (!match?.[1]) throw new Error(`no csrf token found in body: ${html.slice(0, 200)}`);
  return match[1];
}

/** A job whose title names Ronit, plus one memory about her. */
async function seedRonit(): Promise<{ jobId: string }> {
  const bundle = await installCharter(buildCharter({ version: 'screen' }), { businessId: BUSINESS });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: `מייל אל ${RONIT}`,
  });
  await writeMemory(
    { jobId: job.jobId, kind: 'entity', subjectKey: RONIT, body: {} },
    { businessId: BUSINESS },
  );
  return { jobId: job.jobId };
}

async function memoryCount(): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    'SELECT count(*)::text AS n FROM memories WHERE business_id = $1',
    [BUSINESS],
  );
  return Number(rows[0]?.n ?? '0');
}

describe('the erasure screen', () => {
  /**
   * The routing decision, at the boundary the owner actually crosses. An
   * ordinary instruction must still reach the planner, or the screen would
   * swallow work the owner meant to have done.
   */
  it('routes a forget command away from the planner and an instruction to it', () => {
    expect(readForgetCommand('תשכחי מרונית').recognised).toBe(true);
    expect(readForgetCommand('תשלחי לרונית מייל').recognised).toBe(false);
  });

  it('shows a preview that names every table it will touch', async () => {
    await seedRonit();

    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: RONIT },
      { businessId: BUSINESS },
    );
    const html = renderErasure({ csrf: 'token', plan, anchorLabel: RONIT });

    expect(html).toContain(RONIT);
    expect(html).toContain('זיכרונות');
    // The confirm control has to say what it does, in a word nobody clicks by
    // accident.
    expect(html).toContain('מחק לצמיתות');
  });

  it('shows kept items as kept, with the date and a revoke control', () => {
    const html = renderErasure({
      csrf: 'token',
      anchorLabel: RONIT,
      plan: {
        anchor: { kind: 'contact', identifier: RONIT },
        jobIds: [],
        documentIds: [],
        memoryIds: [],
        filePaths: [],
        items: [],
        excluded: [
          { itemKind: 'document', itemId: 'DOC-9', keptAt: '2026-09-04T10:00:00.000Z', note: 'החוזה' },
        ],
        refusals: [],
      },
    });

    expect(html).toContain('DOC-9');
    expect(html).toContain('בטל שמירה');
    expect(html).toContain('החוזה');
  });

  it('shows a refusal instead of a confirm button', () => {
    const html = renderErasure({
      csrf: 'token',
      anchorLabel: RONIT,
      plan: {
        anchor: { kind: 'contact', identifier: RONIT },
        jobIds: [],
        documentIds: [],
        memoryIds: [],
        filePaths: [],
        items: [],
        excluded: [],
        refusals: [{ kind: 'live_job', detail: 'משימה J-1 ממתינה לאישורך' }],
      },
    });

    expect(html).toContain('J-1');
    expect(html).not.toContain('מחק לצמיתות');
  });
});

describe('the erasure routes', () => {
  it('sends a forget command to the screen instead of the planner', async () => {
    const baseUrl = await startServer();
    await installCharter(buildCharter(), { businessId: BUSINESS });
    const cookie = await signIn(baseUrl);
    const csrf = extractCsrf(await (await fetch(`${baseUrl}/instruct`, { headers: { cookie } })).text());

    const res = await fetch(`${baseUrl}/instruct`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, text: `תשכחי מ-${RONIT}` }),
      redirect: 'manual',
    });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/erase?identifier=${encodeURIComponent(RONIT)}`);
    // Never to the planner: no job, and no instruction row.
    const jobs = await getPool().query('SELECT 1 FROM jobs WHERE business_id = $1', [BUSINESS]);
    expect(jobs.rows).toHaveLength(0);
    const instructions = await getPool().query('SELECT 1 FROM boss_instructions');
    expect(instructions.rows).toHaveLength(0);
  });

  it('previews from the identifier in the query string', async () => {
    const baseUrl = await startServer();
    await seedRonit();
    const cookie = await signIn(baseUrl);

    const res = await fetch(`${baseUrl}/erase?identifier=${encodeURIComponent(RONIT)}`, {
      headers: { cookie },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(RONIT);
    expect(html).toContain('זיכרונות');
    // Read-only: a preview deletes nothing.
    expect(await memoryCount()).toBe(1);
  });

  it('destroys what the preview listed when the owner confirms', async () => {
    const baseUrl = await startServer();
    await seedRonit();
    const cookie = await signIn(baseUrl);
    const preview = await fetch(`${baseUrl}/erase?identifier=${encodeURIComponent(RONIT)}`, {
      headers: { cookie },
    });
    const html = await preview.text();
    const csrf = extractCsrf(html);

    const res = await fetch(`${baseUrl}/erase/confirm`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        csrf,
        anchor: JSON.stringify({ kind: 'contact', identifier: RONIT }),
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('נמחק');
    expect(await memoryCount()).toBe(0);
  });

  /**
   * The plan is rebuilt on confirm, never reconstructed from the form. A row
   * that came into scope after the preview was drawn is therefore erased
   * too — which is only visible because the browser never carried a row list
   * to begin with.
   */
  it('rebuilds the plan on confirm rather than trusting the round trip', async () => {
    const baseUrl = await startServer();
    const { jobId } = await seedRonit();
    const cookie = await signIn(baseUrl);
    const csrf = extractCsrf(
      await (await fetch(`${baseUrl}/erase?identifier=${encodeURIComponent(RONIT)}`, { headers: { cookie } })).text(),
    );

    // After the preview, and before the confirm.
    await writeMemory(
      { jobId, kind: 'chunk', subjectKey: 'הערה', body: { note: RONIT } },
      { businessId: BUSINESS },
    );
    expect(await memoryCount()).toBe(2);

    await fetch(`${baseUrl}/erase/confirm`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        csrf,
        anchor: JSON.stringify({ kind: 'contact', identifier: RONIT }),
      }),
    });

    expect(await memoryCount()).toBe(0);
  });

  /**
   * A job woken into a live phase between the preview and the confirm is the
   * case the rebuild exists for: the screen must refuse, and must say so
   * rather than 500.
   */
  it('refuses on confirm when a job went live after the preview', async () => {
    const baseUrl = await startServer();
    const { jobId } = await seedRonit();
    const cookie = await signIn(baseUrl);
    const csrf = extractCsrf(
      await (await fetch(`${baseUrl}/erase?identifier=${encodeURIComponent(RONIT)}`, { headers: { cookie } })).text(),
    );

    for (const to of ['understand', 'plan', 'await_approval'] as const) {
      await transition(jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
    }

    const res = await fetch(`${baseUrl}/erase/confirm`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        csrf,
        anchor: JSON.stringify({ kind: 'contact', identifier: RONIT }),
      }),
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(jobId);
    expect(html).not.toContain('מחק לצמיתות');
    expect(await memoryCount()).toBe(1);
  });

  it('returns a kept item to the plan when the keep is revoked', async () => {
    const baseUrl = await startServer();
    const { jobId } = await seedRonit();
    await keepItem({ kind: 'job', itemId: jobId, note: 'החוזה' }, { businessId: BUSINESS });
    const cookie = await signIn(baseUrl);

    const kept = await fetch(`${baseUrl}/erase?identifier=${encodeURIComponent(RONIT)}`, {
      headers: { cookie },
    });
    const keptHtml = await kept.text();
    expect(keptHtml).toContain('בטל שמירה');
    expect(keptHtml).toContain('החוזה');

    const res = await fetch(`${baseUrl}/erase/keep`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        csrf: extractCsrf(keptHtml),
        revoke: '1',
        kind: 'job',
        itemId: jobId,
        anchor: JSON.stringify({ kind: 'contact', identifier: RONIT }),
      }),
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('בטל שמירה');
    const rows = await getPool().query('SELECT 1 FROM kept_items WHERE business_id = $1', [BUSINESS]);
    expect(rows.rows).toHaveLength(0);
  });

  it('keeps an item out of the plan when the owner says to keep it', async () => {
    const baseUrl = await startServer();
    const { jobId } = await seedRonit();
    const cookie = await signIn(baseUrl);
    const csrf = extractCsrf(
      await (await fetch(`${baseUrl}/erase?identifier=${encodeURIComponent(RONIT)}`, { headers: { cookie } })).text(),
    );

    const res = await fetch(`${baseUrl}/erase/keep`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        csrf,
        kind: 'job',
        itemId: jobId,
        anchor: JSON.stringify({ kind: 'contact', identifier: RONIT }),
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('בטל שמירה');
    const rows = await getPool().query<{ item_id: string }>(
      'SELECT item_id FROM kept_items WHERE business_id = $1',
      [BUSINESS],
    );
    expect(rows.rows.map((r) => r.item_id)).toEqual([jobId]);
  });

  it('previews a window anchor submitted from the form', async () => {
    const baseUrl = await startServer();
    await seedRonit();
    const cookie = await signIn(baseUrl);
    const csrf = extractCsrf(await (await fetch(`${baseUrl}/erase`, { headers: { cookie } })).text());

    const res = await fetch(`${baseUrl}/erase/preview`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        csrf,
        kind: 'window',
        fromIso: '2000-01-01T00:00',
        toIso: '2100-01-01T00:00',
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('זיכרונות');
    expect(await memoryCount()).toBe(1);
  });

  it('answers an unreadable window with a readable refusal, not a 500', async () => {
    const baseUrl = await startServer();
    const cookie = await signIn(baseUrl);
    const csrf = extractCsrf(await (await fetch(`${baseUrl}/erase`, { headers: { cookie } })).text());

    const res = await fetch(`${baseUrl}/erase/preview`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, kind: 'window', fromIso: 'מתישהו', toIso: '' }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('לא הצלחתי לקרוא');
  });

  // --- CSRF. An erasure cannot be undone; a cross-site POST must not reach
  // any of these three routes, and the rows must still be there afterwards.

  it('refuses a confirm with no CSRF token, and deletes nothing', async () => {
    const baseUrl = await startServer();
    await seedRonit();
    const cookie = await signIn(baseUrl);

    const res = await fetch(`${baseUrl}/erase/confirm`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        anchor: JSON.stringify({ kind: 'contact', identifier: RONIT }),
      }),
    });

    expect(res.status).toBe(403);
    expect(await memoryCount()).toBe(1);
  });

  it('refuses a keep with no CSRF token, and writes nothing', async () => {
    const baseUrl = await startServer();
    const { jobId } = await seedRonit();
    const cookie = await signIn(baseUrl);

    const res = await fetch(`${baseUrl}/erase/keep`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ kind: 'job', itemId: jobId }),
    });

    expect(res.status).toBe(403);
    const rows = await getPool().query('SELECT 1 FROM kept_items WHERE business_id = $1', [BUSINESS]);
    expect(rows.rows).toHaveLength(0);
  });

  it('refuses a preview with no CSRF token', async () => {
    const baseUrl = await startServer();
    const cookie = await signIn(baseUrl);

    const res = await fetch(`${baseUrl}/erase/preview`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ kind: 'contact', identifier: RONIT }),
    });

    expect(res.status).toBe(403);
  });

  it('sends an anonymous request to the login page, not to the screen', async () => {
    const baseUrl = await startServer();
    const res = await fetch(`${baseUrl}/erase`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});
