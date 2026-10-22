/**
 * The screen the owner uses to destroy something, and the four routes behind
 * it.
 *
 * Two things are proved here that nothing else on this branch can prove.
 * First, **the preview is the truth**: what the page lists is what the
 * executor removes, refusals included. Second, **the confirm destroys the
 * plan the owner read, and nothing wider** — it rebuilds server-side (a plan
 * that travelled through a browser is a plan the browser could have edited)
 * and then refuses unless the rebuilt plan fingerprints identically to the
 * one the preview showed.
 *
 * Every POST here is guarded by the session's CSRF token. An erasure cannot
 * be undone, so a cross-site form that reached `/erase/confirm` would be the
 * worst defect this file could ship; each route has its own negative test
 * that also asserts the rows are still there afterwards.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
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
import { renderErasure, renderErasureDone, TABLE_LABELS } from './views.js';
import type { ErasureOutcome } from '../governance/erasure.js';

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

/** The hash of the plan the page is showing — what the confirm is authorising. */
function extractPlanHash(html: string): string {
  const match = /name="planHash" value="([0-9a-f]+)"/.exec(html);
  if (!match?.[1]) throw new Error(`no plan hash found in body: ${html.slice(0, 200)}`);
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
    expect(html).toContain('כותרות משימה');
    // "every" as a count, not as a spot check: one row rendered for each item
    // the plan says it will touch, so a label this file forgot to name still
    // fails the assertion instead of slipping through.
    const touched = plan.items.filter((item) => item.count > 0);
    expect(touched.length).toBeGreaterThan(1);
    expect(html.match(/<tr><td>/g) ?? []).toHaveLength(touched.length);
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
        digestIds: [],
        mailIds: [],
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
        digestIds: [],
        mailIds: [],
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
  /**
   * Two properties, and the second is why this is not a redirect.
   *
   * **The screen, not the planner.** A recognised forget command must not
   * reach `runInstruction`, which opens a job, grants a standing
   * authorisation and calls the model on a sentence that says "forget".
   *
   * **And the identity must not end up in a URL** (security review, MEDIUM).
   * This route used to answer `303 /erase?identifier=<address>`. The
   * deployment mandates a reverse proxy — `docs/dashboard-deployment.md` and
   * `DASHBOARD_TRUST_PROXY` both assume one — so that address was written
   * into the proxy's access log and into the browser's history, and it stayed
   * there after the erasure, in two places the erasure cannot reach. For a
   * feature whose whole promise is that the identity is gone and only counts
   * remain, that is the one leak that matters. The screen is rendered inline
   * from the POST instead, so nothing about the contact travels in a URL.
   */
  it('renders the erasure screen inline, with the identity in no URL', async () => {
    const baseUrl = await startServer();
    await installCharter(buildCharter(), { businessId: BUSINESS });
    await seedRonit();
    const cookie = await signIn(baseUrl);
    const csrf = extractCsrf(await (await fetch(`${baseUrl}/instruct`, { headers: { cookie } })).text());

    const res = await fetch(`${baseUrl}/instruct`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, text: `תשכחי מ-${RONIT}` }),
      redirect: 'manual',
    });
    const html = await res.text();

    // Answered in place: no redirect at all, so no URL to carry anything.
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();

    // The assertion that matters: the address appears in NO response header,
    // whatever the header is called. A `Location`-shaped leak under another
    // name fails here too.
    for (const [name, value] of res.headers.entries()) {
      expect(value, `header ${name}`).not.toContain(RONIT);
      expect(value, `header ${name}`).not.toContain(encodeURIComponent(RONIT));
    }

    // Nor in any URL the page itself emits — a form action or a link that
    // carried the prefill would put it back in the history on the next click.
    for (const url of html.match(/(?:action|href)="([^"]*)"/g) ?? []) {
      expect(url).not.toContain(RONIT);
      expect(url).not.toContain(encodeURIComponent(RONIT));
    }

    // It is genuinely the erasure screen, prefilled and already previewing —
    // the same thing `GET /erase?identifier=` produced.
    expect(html).toContain(RONIT);
    expect(html).toContain('זיכרונות');
    expect(html).toContain('name="planHash"');

    // The forms it emits post to absolute paths, so they still work when the
    // page was served from `/instruct` rather than from `/erase`.
    expect(html).toContain('action="/erase/preview"');
    expect(html).toContain('action="/erase/confirm"');

    // Never to the planner: no job, and no instruction row.
    const jobs = await getPool().query(
      'SELECT 1 FROM jobs WHERE business_id = $1 AND title IS NULL',
      [BUSINESS],
    );
    expect(jobs.rows).toHaveLength(0);
    const instructions = await getPool().query('SELECT 1 FROM boss_instructions');
    expect(instructions.rows).toHaveLength(0);

    // And read-only: a preview destroys nothing.
    expect(await memoryCount()).toBe(1);
  });

  /**
   * The date-only shape, which takes the other branch: no anchor is resolved,
   * so the entry form is rendered with the window prefilled — and the date,
   * like the address, never reaches a URL.
   */
  it('renders the entry form inline for a date-only forget command', async () => {
    const baseUrl = await startServer();
    await installCharter(buildCharter(), { businessId: BUSINESS });
    const cookie = await signIn(baseUrl);
    const csrf = extractCsrf(await (await fetch(`${baseUrl}/instruct`, { headers: { cookie } })).text());

    const res = await fetch(`${baseUrl}/instruct`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, text: 'תשכחי מהשיחה של 3/9/2026' }),
      redirect: 'manual',
    });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    for (const [name, value] of res.headers.entries()) {
      expect(value, `header ${name}`).not.toContain('2026-09-03');
    }
    expect(html).toContain('2026-09-03T00:00');
    expect(html).toContain('2026-09-03T23:59');
    // No anchor was resolved, so there is nothing to confirm yet.
    expect(html).not.toContain('name="planHash"');
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

  /**
   * A job woken into a live phase between the preview and the confirm is the
   * case the rebuild exists for: the screen must refuse, and must say so
   * rather than 500.
   */
  /**
   * Spec §6: *"every erasure screen shows what is kept"*.
   *
   * The preview screen renders `plan.excluded`, which holds only the kept
   * items the anchor happened to reach. The ENTRY screen has no anchor and
   * no plan, and before this it showed nothing kept at all — so a keep the
   * owner set last month was invisible until they happened to build a preview
   * that reached it. `listKept` existed for exactly this and had no reader
   * outside its own test, which is the shape this codebase has a documented
   * allergy to (`compiled policy has a reader`).
   *
   * The kept item here is deliberately one NO anchor on this screen reaches,
   * so the assertion cannot pass through the preview path by accident.
   */
  it('shows what is kept on the entry screen, where there is no plan at all', async () => {
    const baseUrl = await startServer();
    const cookie = await signIn(baseUrl);
    await keepItem(
      { kind: 'memory', itemId: 'MEM-unreachable-by-any-anchor', note: 'הסיכום מהישיבה' },
      { businessId: BUSINESS },
    );

    const res = await fetch(`${baseUrl}/erase`, { headers: { cookie } });
    const html = await res.text();

    expect(res.status).toBe(200);
    // No preview on this page at all — this is the entry screen.
    expect(html).not.toContain('name="planHash"');
    expect(html).toContain('MEM-unreachable-by-any-anchor');
    expect(html).toContain('הסיכום מהישיבה');
    // And the revoke control, so the list is actionable and not decorative.
    expect(html).toContain('name="revoke" value="1"');
  });

  /**
   * The other direction, without which the test above is satisfied by a page
   * that prints a kept heading unconditionally.
   */
  it('says nothing about kept items on the entry screen when nothing is kept', async () => {
    const baseUrl = await startServer();
    const cookie = await signIn(baseUrl);

    const html = await (await fetch(`${baseUrl}/erase`, { headers: { cookie } })).text();

    expect(html).not.toContain('name="revoke" value="1"');
    expect(html).not.toContain('יישמרו לפי הוראתך');
  });

  it('refuses on confirm when a job went live after the preview', async () => {
    const baseUrl = await startServer();
    const { jobId } = await seedRonit();
    const cookie = await signIn(baseUrl);
    const previewHtml = await (
      await fetch(`${baseUrl}/erase?identifier=${encodeURIComponent(RONIT)}`, { headers: { cookie } })
    ).text();

    for (const to of ['understand', 'plan', 'await_approval'] as const) {
      await transition(jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
    }

    const res = await fetch(`${baseUrl}/erase/confirm`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        csrf: extractCsrf(previewHtml),
        planHash: extractPlanHash(previewHtml),
        anchor: JSON.stringify({ kind: 'contact', identifier: RONIT }),
      }),
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(jobId);
    // The plan-time refusal, not the hash handshake: a refusal is the more
    // useful thing to say, so it is checked first and its wording proves it.
    expect(html).toContain('ותלויה בפריטים האלה');
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
    // Back in the plan, not merely absent from the kept block — without this
    // the assertion above also holds for a handler that fell through to the
    // empty entry form.
    expect(html).toContain(jobId);
    expect(html).toContain('שמור את זה');
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

describe('the done screen', () => {
  const outcome = (over: Partial<ErasureOutcome> = {}): ErasureOutcome => ({
    deleted: [{ table: 'memories', action: 'delete', count: 2 }],
    filesRemoved: 0,
    filesAlreadyGone: [],
    filesFailed: [],
    ...over,
  });

  /**
   * §7's own obligation on this screen. `filesRemoved` alone cannot tell the
   * owner apart a run with no files to delete from a run that failed to
   * delete every file it named — which is exactly the shape the relative-path
   * defect took.
   */
  it('says how many files the plan named, not only how many it deleted', () => {
    const html = renderErasureDone({
      anchorLabel: RONIT,
      plannedFiles: 3,
      outcome: outcome({ filesRemoved: 1, filesAlreadyGone: ['/root/a', '/root/b'] }),
      auditUnrecorded: false,
    });

    expect(html).toContain('3');
    expect(html).toContain('כבר לא היו');
    expect(html).toContain('/root/a');
  });

  it('calls out a run that named files and deleted none of them', () => {
    const html = renderErasureDone({
      anchorLabel: RONIT,
      plannedFiles: 2,
      outcome: outcome({ filesRemoved: 0, filesAlreadyGone: ['/root/a', '/root/b'] }),
      auditUnrecorded: false,
    });

    expect(html).toContain('אף קובץ לא נמחק בפועל');
  });

  it('lists every path that failed, so it can be cleaned by hand', () => {
    const html = renderErasureDone({
      anchorLabel: RONIT,
      plannedFiles: 1,
      outcome: outcome({ filesFailed: ['/root/left-behind.txt'] }),
      auditUnrecorded: false,
    });

    expect(html).toContain('/root/left-behind.txt');
    expect(html).toContain('נשארו על הדיסק');
  });

  /**
   * The defining rule of this screen: an erasure that already happened is
   * never reported as one that did not.
   */
  it('reports a missing audit row as a completed erasure, never as a failure', () => {
    const html = renderErasureDone({
      anchorLabel: RONIT,
      plannedFiles: 0,
      outcome: outcome(),
      auditUnrecorded: true,
    });

    expect(html).toContain('המחיקה בוצעה במלואה');
    expect(html).not.toContain('המחיקה נכשלה');
    expect(html).not.toContain('לא נמחק דבר');
  });
});

describe('what the owner authorised', () => {
  /**
   * Spec §4.4 makes the PLAN the unit of authorisation: the executor removes
   * exactly what the plan lists, and that is what makes the preview the truth
   * rather than a decoration. Rebuilding from a round-tripped anchor is right
   * — a plan the browser carried is a plan the browser could have edited —
   * but rebuilding *and then acting* means the destroyed set can be wider than
   * the counts the owner read.
   *
   * The handshake is the one this codebase already owns for approvals: the
   * preview renders a hash of the plan, the confirm rebuilds and hashes again,
   * and a difference re-shows rather than destroys. The anchor still travels;
   * it is simply no longer what is trusted.
   */
  it('refuses to destroy a plan that grew between the preview and the confirm', async () => {
    const baseUrl = await startServer();
    const { jobId } = await seedRonit();
    const cookie = await signIn(baseUrl);
    const previewHtml = await (
      await fetch(`${baseUrl}/erase?identifier=${encodeURIComponent(RONIT)}`, { headers: { cookie } })
    ).text();
    const csrf = extractCsrf(previewHtml);
    const planHash = extractPlanHash(previewHtml);

    // The world moves. A second memory comes into scope after the owner read
    // the counts and before they clicked.
    await writeMemory(
      { jobId, kind: 'chunk', subjectKey: 'הערה', body: { note: RONIT } },
      { businessId: BUSINESS },
    );
    expect(await memoryCount()).toBe(2);

    const res = await fetch(`${baseUrl}/erase/confirm`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        csrf,
        planHash,
        anchor: JSON.stringify({ kind: 'contact', identifier: RONIT }),
      }),
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('השתנה מאז');
    // Nothing destroyed, and the owner is looking at the new preview.
    expect(await memoryCount()).toBe(2);
    expect(html).toContain('מחק לצמיתות');
    expect(extractPlanHash(html)).not.toBe(planHash);
  });

  it('destroys when the rebuilt plan is the one the owner read', async () => {
    const baseUrl = await startServer();
    await seedRonit();
    const cookie = await signIn(baseUrl);
    const previewHtml = await (
      await fetch(`${baseUrl}/erase?identifier=${encodeURIComponent(RONIT)}`, { headers: { cookie } })
    ).text();

    const res = await fetch(`${baseUrl}/erase/confirm`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        csrf: extractCsrf(previewHtml),
        planHash: extractPlanHash(previewHtml),
        anchor: JSON.stringify({ kind: 'contact', identifier: RONIT }),
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('נמחק');
    expect(await memoryCount()).toBe(0);
  });

  /** Fail closed: no hash is not "no objection", it is "nothing was authorised". */
  it('refuses a confirm that carries no plan hash at all', async () => {
    const baseUrl = await startServer();
    await seedRonit();
    const cookie = await signIn(baseUrl);
    const csrf = extractCsrf(
      await (await fetch(`${baseUrl}/erase?identifier=${encodeURIComponent(RONIT)}`, { headers: { cookie } })).text(),
    );

    const res = await fetch(`${baseUrl}/erase/confirm`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        csrf,
        anchor: JSON.stringify({ kind: 'contact', identifier: RONIT }),
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('השתנה מאז');
    expect(await memoryCount()).toBe(1);
  });
});

describe('the two ways a confirm ends other than cleanly', () => {
  /**
   * The window neither the plan-time refusal nor the hash handshake can
   * close: a job woken into a live phase *after* the confirm rebuilt and
   * hashed, and before the executor's locked re-read. Forced deterministically
   * — the test holds `FOR UPDATE` on the job row and flips its phase inside an
   * uncommitted transaction, so the confirm's rebuild reads the old snapshot
   * and the executor blocks on the lock until the test commits.
   *
   * Asserted on the executor's own wording (`מאז שהתצוגה המקדימה הוכנה`),
   * which `buildErasurePlan`'s refusal does not use: if the timing slipped and
   * the plan-time branch handled it instead, this fails rather than passing
   * from the wrong branch.
   */
  it('renders the executor’s own refusal when a job goes live mid-transaction', async () => {
    const baseUrl = await startServer();
    const { jobId } = await seedRonit();
    const cookie = await signIn(baseUrl);
    const previewHtml = await (
      await fetch(`${baseUrl}/erase?identifier=${encodeURIComponent(RONIT)}`, { headers: { cookie } })
    ).text();

    const blocker = await getPool().connect();
    let pending: Promise<Response>;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT job_id FROM jobs WHERE job_id = $1 FOR UPDATE', [jobId]);
      await blocker.query(`UPDATE jobs SET phase = 'await_approval' WHERE job_id = $1`, [jobId]);

      pending = fetch(`${baseUrl}/erase/confirm`, {
        method: 'POST',
        headers: { cookie },
        body: new URLSearchParams({
          csrf: extractCsrf(previewHtml),
          planHash: extractPlanHash(previewHtml),
          anchor: JSON.stringify({ kind: 'contact', identifier: RONIT }),
        }),
      });

      // Long enough for the request to rebuild, hash, and reach the executor's
      // `FOR UPDATE`, where it parks on the lock this transaction holds.
      await new Promise((resolve) => setTimeout(resolve, 800));
      await blocker.query('COMMIT');
    } finally {
      blocker.release();
    }

    const res = await pending;
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('מאז שהתצוגה המקדימה הוכנה');
    expect(html).not.toContain('מחק לצמיתות');
    expect(await memoryCount()).toBe(1);
  });

  /**
   * The erasure committed; the record of it did not. The owner must never be
   * told their data survived when it has not — so this asserts the rows are
   * really gone *and* that the page says the erasure completed.
   *
   * Forced by a trigger that makes the `audit_log` insert raise. Dropped in
   * `finally`; `fileParallelism: false` means no other file is running.
   */
  it('reports an erasure whose audit row failed as done, and it really is done', async () => {
    const baseUrl = await startServer();
    await seedRonit();
    const cookie = await signIn(baseUrl);
    const previewHtml = await (
      await fetch(`${baseUrl}/erase?identifier=${encodeURIComponent(RONIT)}`, { headers: { cookie } })
    ).text();

    let res: Response;
    try {
      await getPool().query(
        `CREATE OR REPLACE FUNCTION erasure_audit_boom() RETURNS trigger AS $fn$
           BEGIN RAISE EXCEPTION 'audit unavailable'; END;
         $fn$ LANGUAGE plpgsql`,
      );
      await getPool().query(
        `CREATE TRIGGER erasure_audit_boom BEFORE INSERT ON audit_log
           FOR EACH ROW EXECUTE FUNCTION erasure_audit_boom()`,
      );

      res = await fetch(`${baseUrl}/erase/confirm`, {
        method: 'POST',
        headers: { cookie },
        body: new URLSearchParams({
          csrf: extractCsrf(previewHtml),
          planHash: extractPlanHash(previewHtml),
          anchor: JSON.stringify({ kind: 'contact', identifier: RONIT }),
        }),
      });
    } finally {
      await getPool().query('DROP TRIGGER IF EXISTS erasure_audit_boom ON audit_log');
      await getPool().query('DROP FUNCTION IF EXISTS erasure_audit_boom()');
    }

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('המחיקה בוצעה במלואה');
    expect(html).not.toContain('המחיקה נכשלה');
    // It really happened.
    expect(await memoryCount()).toBe(0);
  });
});

describe('the smaller things the screen owes the owner', () => {
  /**
   * The prefill reaches a visible input from the query string — a link, not
   * necessarily something the owner typed. A right-to-left override there
   * re-orders the address they are about to authorise a destruction against.
   */
  it('strips bidirectional overrides from the values it puts back in the form', () => {
    const html = renderErasure({
      csrf: 'token',
      anchorLabel: '',
      plan: null,
      prefill: { identifier: 'dana‮exe.gpj@example.com' },
    });

    expect(html).not.toContain('‮');
    expect(html).toContain('exe.gpj@example.com');
  });

  it('gives the irreversible button a style of its own', () => {
    const html = renderErasure({
      csrf: 'token',
      anchorLabel: RONIT,
      plan: {
        anchor: { kind: 'contact', identifier: RONIT },
        jobIds: [],
        documentIds: [],
        memoryIds: [],
        digestIds: [],
        mailIds: [],
        filePaths: [],
        items: [],
        excluded: [],
        refusals: [],
      },
    });

    expect(html).toContain('class="danger"');
    expect(html).toMatch(/\.danger\s*\{/);
  });

  /** Spec §6's free-text note, reachable from the screen and not only from the DB. */
  it('carries the owner’s note into the keep, and shows it back', async () => {
    const baseUrl = await startServer();
    const { jobId } = await seedRonit();
    const cookie = await signIn(baseUrl);
    const previewHtml = await (
      await fetch(`${baseUrl}/erase?identifier=${encodeURIComponent(RONIT)}`, { headers: { cookie } })
    ).text();
    expect(previewHtml).toContain('name="note"');

    const res = await fetch(`${baseUrl}/erase/keep`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        csrf: extractCsrf(previewHtml),
        kind: 'job',
        itemId: jobId,
        note: 'צריך את זה לביקורת המס',
        anchor: JSON.stringify({ kind: 'contact', identifier: RONIT }),
      }),
    });

    expect(await res.text()).toContain('צריך את זה לביקורת המס');
    const rows = await getPool().query<{ note: string | null }>(
      'SELECT note FROM kept_items WHERE business_id = $1 AND item_id = $2',
      [BUSINESS, jobId],
    );
    expect(rows.rows[0]?.note).toBe('צריך את זה לביקורת המס');
  });
});

/**
 * Fix round 4, item 2. `TABLE_LABELS` had no entry for `agent_envelopes`,
 * `verification_verdicts` or `autonomy_marks` — three tables `countItems`
 * (`governance/erasure-plan.ts`) already counts — and `rowLabel`'s fallback
 * (`?? item.table`) let the confirmation screen print the raw English
 * identifier next to every other row's Hebrew name, on the one page this
 * project's own docblock calls a contract.
 *
 * The expected set is READ OUT of `countItems`'s own source text, not
 * restated by hand here — the same principle `erasure-invariants.test.ts`
 * already applies by reading `information_schema` instead of a written
 * table list: a hand-written expectation list is exactly the kind of second
 * copy that drifts, and a table added to `countItems` a year from now with
 * no matching `TABLE_LABELS` entry must fail this test without anyone having
 * remembered it exists.
 */
describe('every table countItems can emit has a Hebrew label', () => {
  /** Every table name `countItems` passes as its first argument to `one(...)`. */
  async function countedTables(): Promise<string[]> {
    const source = await readFile('src/governance/erasure-plan.ts', 'utf8');
    const tables: string[] = [];
    for (const match of source.matchAll(/await one\(\s*\n\s*'([a-z_]+)'/g)) {
      const table = match[1];
      if (table !== undefined) tables.push(table);
    }
    return tables;
  }

  it('finds table names in countItems, sanity-checking the extraction itself', async () => {
    const tables = await countedTables();

    // An empty or tiny result would make the invariant below vacuous — the
    // same failure mode `reading-invariants.test.ts` and
    // `erasure-invariants.test.ts` both guard against for their own sweeps.
    expect(tables.length).toBeGreaterThan(10);
    expect(tables).toContain('agent_envelopes');
    expect(tables).toContain('verification_verdicts');
    expect(tables).toContain('autonomy_marks');
  });

  it('has a TABLE_LABELS entry for every one of them', async () => {
    const tables = new Set(await countedTables());

    const missing = [...tables].filter((table) => !Object.hasOwn(TABLE_LABELS, table));
    expect(missing).toEqual([]);
  });
});
