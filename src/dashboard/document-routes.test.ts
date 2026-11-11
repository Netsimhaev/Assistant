/**
 * The document screens (document production §4, §8.1, C12, D13, D14):
 * upload beside the instruction box, the card list and card, download,
 * approve, fix, a typed address, and the settings page. Real HTTP server,
 * real Postgres.
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { config } from '../config.js';
import { closePool, getPool, withBusiness } from '../db/pool.js';
import type { DocxSpec } from '../domain/document-spec.js';
import type { Plan } from '../domain/plan.js';
import { DOCUMENT_SETTINGS_HE, loadDocumentSettings } from '../governance/document-settings.js';
import { attachedDocumentsForJob } from '../governance/instructions.js';
import { buildDeliveryOptions, createDocumentCard, loadDocumentCard, typedAddressProblem } from '../production/card.js';
import { advanceStage, createProduction, loadProduction, loadVersion, saveVersion, saveVersionCheck, type ProductionDestination } from '../production/store.js';
import type { PlanOutcome, PlanRequest } from '../sdk/planner.js';
import { resetDatabase, TEST_BUSINESS } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { createOwner } from './auth.js';
import { createServer, type DashboardOptions } from './server.js';

const B = 'test-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';
const DIR = `produced/__routes-${process.pid}`;
const AVAILABLE = { available: true, sofficePath: '/opt/soffice', chromiumPath: '/opt/chromium' };

const spec: DocxSpec = {
  format: 'docx',
  language: 'he',
  kind: 'letter',
  title: 'הצעת מחיר לאלפא',
  filename: 'הצעה',
  style: { theme: 'clean', accent: 'navy' },
  sources: [],
  blocks: [{ type: 'paragraph', text: 'שלום' }],
};

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

let server: Server | null = null;
let uploadRoot = '';

beforeEach(async () => {
  await resetDatabase();
  await createOwner({ username: USERNAME, password: PASSWORD, businessId: B });
  await withBusiness(B, (bdb) => installCharter(bdb, buildCharter({ version: 'gate-charter' }))); // TENANCY-TODO(task 10)
  uploadRoot = await mkdtemp(join(tmpdir(), 'doc-routes-'));
});
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  await rm(join(config.documentRoot, DIR), { recursive: true, force: true });
  await rm(uploadRoot, { recursive: true, force: true });
});
afterAll(async () => {
  await closePool();
});

async function start(options: Partial<DashboardOptions> = {}): Promise<string> {
  server = createServer({ businessId: B, port: 0, documentRoot: uploadRoot, ...options });
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

async function get(baseUrl: string, cookie: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: 'manual' });
}

async function csrfOf(baseUrl: string, cookie: string, path: string): Promise<string> {
  const html = await (await get(baseUrl, cookie, path)).text();
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  if (!m?.[1]) throw new Error('no csrf token on ' + path);
  return m[1];
}

async function post(baseUrl: string, cookie: string, path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { cookie },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

async function deliveryJobs(): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>('SELECT count(*)::text AS n FROM document_deliveries');
  return Number(rows[0]?.n ?? 0);
}

let seq = 0;
async function card(
  options: { destination?: ProductionDestination; stage?: 'ready' | 'failed_checks'; preview?: Buffer } = {},
): Promise<{ cardId: string; versionId: string; productionId: string; bytes: Buffer; path: string }> {
  seq += 1;
  const productionId = await withBusiness(B, (db) => createProduction(db, {
    originJobId: 'J-origin',
    instructionText: 'תכיני הצעת מחיר ותשלחי ל-dana@example.com',
    textOrigin: 'typed',
    format: 'docx',
    language: 'he',
    kind: 'letter',
    destination: options.destination ?? { mode: 'send', to: ['dana@example.com'] },
    sourceDocumentIds: [],
  }));
  const bytes = Buffer.from(`docx bytes ${productionId} ${seq}`);
  const storedPath = `${DIR}/${productionId}.docx`;
  // Under the dashboard's own document root (M7): the download reads from
  // the root the server was given, never a second one.
  await mkdir(join(uploadRoot, DIR), { recursive: true });
  await writeFile(join(uploadRoot, storedPath), bytes);
  const versionId = await withBusiness(TEST_BUSINESS, (db) => saveVersion(db, { productionId, versionNo: 1, spec, storedPath, sha256: sha(bytes), sizeBytes: bytes.length }));
  await withBusiness(TEST_BUSINESS, (db) => saveVersionCheck(db, versionId, 'check1', { passed: true, findings: [] }));
  let previewPath: string | null = null;
  if (options.preview !== undefined) {
    // Under the dashboard's own document root — the root the production
    // loop and the upload write under — never a second one.
    previewPath = `${DIR}/${versionId}.preview.png`;
    await mkdir(join(uploadRoot, DIR), { recursive: true });
    await writeFile(join(uploadRoot, previewPath), options.preview);
  }
  await withBusiness(TEST_BUSINESS, (db) => saveVersionCheck(db, versionId, 'check2', { passed: options.stage !== 'failed_checks', status: 'judged', findings: [], previewPath }));
  expect(await withBusiness(TEST_BUSINESS, (db) => advanceStage(db, productionId, 'queued', options.stage ?? 'ready', {
    ...(options.stage === 'failed_checks'
      ? { findings: [{ check: 'check1' as const, code: 'ungrounded_number', where: 'p1', he: 'מספר שלא נמצא במקור' }] }
      : {}),
  }))).toBe(true);
  const created = await withBusiness(B, (db) => createDocumentCard(db, versionId));
  return { cardId: created.cardId, versionId, productionId, bytes, path: join(uploadRoot, storedPath) };
}

const recallPlan: Plan = {
  goal: 'להיזכר',
  assumptions: [],
  clarifyingQuestion: null,
  estimatedCostMinor: 0,
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'להיזכר',
      toolName: 'memory.recall',
      input: { subject: 'dana@example.com' },
      dependsOn: [],
      expectedActionClass: null,
    },
  ],
};

function multipart(fields: Record<string, string>, file: { name: string; bytes: Buffer } | null): { body: Buffer; type: string } {
  const boundary = '----routes-boundary-9q';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  if (file !== null) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/plain\r\n\r\n`,
        'utf8',
      ),
      file.bytes,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

describe('upload on /instruct', () => {
  it('upload ingests and the instruction receives the document id', async () => {
    const seen: PlanRequest[] = [];
    const baseUrl = await start({
      planner: async (request): Promise<PlanOutcome> => {
        seen.push(request);
        return { status: 'planned', plan: recallPlan };
      },
    });
    const cookie = await login(baseUrl);
    const csrf = await csrfOf(baseUrl, cookie, '/instruct');
    expect(await (await get(baseUrl, cookie, '/instruct')).text()).toContain('type="file"');

    const name = '../../מחירון אלפא.txt';
    const { body, type } = multipart(
      { csrf, text: 'תכיני טבלת רווח לפי המחירון המצורף' },
      { name, bytes: Buffer.from('מוצר,מחיר\nא,100\n', 'utf8') },
    );
    const res = await fetch(`${baseUrl}/instruct`, {
      method: 'POST',
      headers: { cookie, 'content-type': type },
      body,
      redirect: 'manual',
    });
    expect(res.status).toBeLessThan(400);

    const { rows } = await getPool().query<{ document_id: string; original_name: string; stored_path: string; source: string }>(
      'SELECT document_id, original_name, stored_path, source FROM documents WHERE business_id = $1',
      [B],
    );
    expect(rows).toHaveLength(1);
    const doc = rows[0]!;
    // The name is data: stored verbatim, never part of the path.
    expect(doc.original_name).toBe(name);
    expect(doc.stored_path).not.toContain('..');
    // The owner's own input, never a stranger's document for the conductor.
    expect(doc.source).toBe('instruction');
    expect(seen[0]?.attachedDocuments).toEqual([{ documentId: doc.document_id, name }]);

    const job = await getPool().query<{ job_id: string }>('SELECT job_id FROM boss_instructions WHERE business_id = $1', [B]);
    expect(await attachedDocumentsForJob(job.rows[0]!.job_id, { businessId: B })).toEqual([doc.document_id]);
  });

  it('a rejected ingest shows its Hebrew reason and the instruction is not run', async () => {
    let called = 0;
    const baseUrl = await start({
      planner: async (): Promise<PlanOutcome> => {
        called += 1;
        return { status: 'planned', plan: recallPlan };
      },
    });
    const cookie = await login(baseUrl);
    const csrf = await csrfOf(baseUrl, cookie, '/instruct');
    const { body, type } = multipart(
      { csrf, text: 'תכיני טבלה' },
      { name: 'x.bin', bytes: Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x00, 0x9c, 0x80]) },
    );
    const res = await fetch(`${baseUrl}/instruct`, { method: 'POST', headers: { cookie, 'content-type': type }, body, redirect: 'manual' });
    expect(res.status).toBe(400);
    const { rows } = await getPool().query<{ reason: string | null; status: string }>(
      'SELECT reason, status FROM documents WHERE business_id = $1',
      [B],
    );
    expect(rows[0]?.status).toBe('rejected');
    const html = await res.text();
    expect(html).toContain(rows[0]!.reason!.slice(0, 10));
    expect(called).toBe(0);
    const { rows: jobs } = await getPool().query('SELECT 1 FROM boss_instructions WHERE business_id = $1', [B]);
    expect(jobs).toHaveLength(0);
  });

  for (const [label, text, reason] of [
    ['empty', '   ', 'ההוראה ריקה.'],
    ['over-length', 'א'.repeat(4_001), 'ההוראה ארוכה מ-4000 תווים'],
  ] as const) {
    it(`an ${label} instruction with a file is refused before the file is ingested`, async () => {
      let called = 0;
      const baseUrl = await start({
        planner: async (): Promise<PlanOutcome> => {
          called += 1;
          return { status: 'planned', plan: recallPlan };
        },
      });
      const cookie = await login(baseUrl);
      const csrf = await csrfOf(baseUrl, cookie, '/instruct');
      const { body, type } = multipart({ csrf, text }, { name: 'a.txt', bytes: Buffer.from('מוצר,מחיר\nא,100\n', 'utf8') });
      const res = await fetch(`${baseUrl}/instruct`, { method: 'POST', headers: { cookie, 'content-type': type }, body, redirect: 'manual' });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(reason);
      const { rows } = await getPool().query('SELECT 1 FROM documents WHERE business_id = $1', [B]);
      expect(rows).toHaveLength(0);
      expect(called).toBe(0);
    });
  }

  it('an upload without a valid CSRF token is refused before anything is ingested', async () => {
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const { body, type } = multipart({ csrf: 'forged', text: 'x' }, { name: 'a.txt', bytes: Buffer.from('a') });
    const res = await fetch(`${baseUrl}/instruct`, { method: 'POST', headers: { cookie, 'content-type': type }, body, redirect: 'manual' });
    expect(res.status).toBe(403);
    const { rows } = await getPool().query('SELECT 1 FROM documents');
    expect(rows).toHaveLength(0);
  });
});

describe('/documents', () => {
  it('lists cards, open first, and marks them seen', async () => {
    const a = await card();
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    expect((await withBusiness(B, (db) => loadDocumentCard(db, a.cardId)))?.seenAt).toBe(null);
    const html = await (await get(baseUrl, cookie, '/documents')).text();
    expect(html).toContain('הצעת מחיר לאלפא');
    expect(html).toContain(`/documents/${a.cardId}`);
    expect((await withBusiness(B, (db) => loadDocumentCard(db, a.cardId)))?.seenAt).not.toBe(null);
  });

  it('the card shows both checks, the full echo of every option, and the buttons', async () => {
    const a = await card({ preview: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')]) });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, `/documents/${a.cardId}`)).text();
    expect(html).toContain('בדיקה ראשונה');
    expect(html).toContain('בדיקה שנייה');
    expect(html).toContain('dana@example.com');
    expect(html).toContain('שלחי ל-dana@example.com');
    expect(html).toContain('שמרי במחשב בלבד');
    expect(html).toContain('בקשי תיקון');
    expect(html).toContain(`/documents/${a.cardId}/download`);
    expect(html).toContain(`/documents/${a.cardId}/preview`);
    const preview = await get(baseUrl, cookie, `/documents/${a.cardId}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('image/png');
    expect(preview.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('a card with no stored preview says so', async () => {
    const a = await card();
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, `/documents/${a.cardId}`)).text();
    expect(html).toContain('אין תצוגה מקדימה');
    expect((await get(baseUrl, cookie, `/documents/${a.cardId}/preview`)).status).toBe(404);
  });

  it('download re-hashes and refuses a mismatching file', async () => {
    const a = await card();
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const ok = await get(baseUrl, cookie, `/documents/${a.cardId}/download`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-disposition')).toMatch(/^attachment; filename="document"; filename\*=UTF-8''/);
    expect(decodeURIComponent(ok.headers.get('content-disposition')!.split("''")[1]!)).toBe('הצעה.docx');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await ok.arrayBuffer()).equals(a.bytes)).toBe(true);

    // Same length, different bytes: only the hash can tell.
    const tampered = Buffer.from(a.bytes);
    tampered[0] = tampered[0]! ^ 0xff;
    await writeFile(a.path, tampered);
    const refused = await get(baseUrl, cookie, `/documents/${a.cardId}/download`);
    expect(refused.status).toBe(409);
    expect(refused.headers.get('content-disposition')).toBe(null);
    expect(await refused.text()).not.toContain(tampered.toString('latin1'));
  });

  it('approve without CSRF is refused', async () => {
    const a = await card();
    const option = (await withBusiness(B, (db) => loadDocumentCard(db, a.cardId)))!.deliveryPlans[0]!;
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const res = await post(baseUrl, cookie, `/documents/${a.cardId}/approve`, { planHash: option.planHash, csrf: 'forged' });
    expect(res.status).toBe(403);
    expect((await withBusiness(B, (db) => loadDocumentCard(db, a.cardId)))?.state).toBe('open');
    expect(await deliveryJobs()).toBe(0);
  });

  it('approve with CSRF and a shown plan hash creates the delivery job', async () => {
    const a = await card();
    const option = (await withBusiness(B, (db) => loadDocumentCard(db, a.cardId)))!.deliveryPlans.find((o) => o.option === 'send')!;
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const csrf = await csrfOf(baseUrl, cookie, `/documents/${a.cardId}`);
    const res = await post(baseUrl, cookie, `/documents/${a.cardId}/approve`, { planHash: option.planHash, csrf });
    expect(res.status).toBe(303);
    expect((await withBusiness(B, (db) => loadDocumentCard(db, a.cardId)))?.state).toBe('approved');
    expect(await deliveryJobs()).toBe(1);
  });

  it('the approve route never takes a recipient', async () => {
    const a = await card({ destination: { mode: 'send', to: [] } });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const csrf = await csrfOf(baseUrl, cookie, `/documents/${a.cardId}`);
    const res = await post(baseUrl, cookie, `/documents/${a.cardId}/approve`, { to: 'evil@x.example', planHash: 'nothing', csrf });
    expect(res.status).toBe(409);
    expect(await deliveryJobs()).toBe(0);
    expect((await withBusiness(B, (db) => loadProduction(db, a.productionId)))?.destination).toEqual({ mode: 'send', to: [] });
  });

  it('failed_checks card has no send button and the approve route refuses send', async () => {
    const a = await card({ stage: 'failed_checks' });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, `/documents/${a.cardId}`)).text();
    expect(html).toContain('לא עבר בדיקה');
    expect(html).toContain('מספר שלא נמצא במקור');
    expect(html).not.toContain('שלחי ל-');
    expect(html).toContain('המסמך לא עבר את הבדיקות');

    // The send plan the card would have offered had the version passed.
    const production = (await withBusiness(B, (db) => loadProduction(db, a.productionId)))!;
    const version = (await withBusiness(B, (db) => loadVersion(db, a.versionId)))!;
    const send = buildDeliveryOptions({ ...production, stage: 'ready' }, version, 'ready').find((o) => o.option === 'send')!;
    const csrf = await csrfOf(baseUrl, cookie, `/documents/${a.cardId}`);
    const res = await post(baseUrl, cookie, `/documents/${a.cardId}/approve`, { planHash: send.planHash, csrf });
    expect(res.status).toBe(409);
    expect(await deliveryJobs()).toBe(0);
    expect((await withBusiness(B, (db) => loadDocumentCard(db, a.cardId)))?.state).toBe('open');
  });

  it('C12: a send card with no authorised recipient takes a typed address and then offers it', async () => {
    const a = await card({ destination: { mode: 'send', to: [] } });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, `/documents/${a.cardId}`)).text();
    expect(html).toContain(`/documents/${a.cardId}/address`);
    expect(html).not.toContain('שלחי ל-');

    const csrf = await csrfOf(baseUrl, cookie, `/documents/${a.cardId}`);
    const bad = await post(baseUrl, cookie, `/documents/${a.cardId}/address`, { to: 'not an address', csrf });
    expect(bad.status).toBe(400);
    expect((await withBusiness(B, (db) => loadDocumentCard(db, a.cardId)))?.deliveryPlans.some((o) => o.option === 'send')).toBe(false);

    const res = await post(baseUrl, cookie, `/documents/${a.cardId}/address`, { to: 'yossi@client.example', csrf });
    expect(res.status).toBe(303);
    const after = (await withBusiness(B, (db) => loadDocumentCard(db, a.cardId)))!;
    const send = after.deliveryPlans.find((o) => o.option === 'send')!;
    expect(send.plan.steps[0]?.input).toMatchObject({ to: ['yossi@client.example'] });
    // Nothing approved yet: the owner presses the new option like any other.
    expect(after.state).toBe('open');
    expect(await deliveryJobs()).toBe(0);
    const approved = await post(baseUrl, cookie, `/documents/${a.cardId}/approve`, { planHash: send.planHash, csrf });
    expect(approved.status).toBe(303);
    expect(await deliveryJobs()).toBe(1);
  });

  it('a typed address without CSRF is refused', async () => {
    const a = await card({ destination: { mode: 'send', to: [] } });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const res = await post(baseUrl, cookie, `/documents/${a.cardId}/address`, { to: 'yossi@client.example', csrf: 'forged' });
    expect(res.status).toBe(403);
    expect((await withBusiness(B, (db) => loadProduction(db, a.productionId)))?.destination).toEqual({ mode: 'send', to: [] });
  });

  it('a fix request opens a new production and supersedes the card', async () => {
    const a = await card();
    const baseUrl = await start({ production: AVAILABLE });
    const cookie = await login(baseUrl);
    const csrf = await csrfOf(baseUrl, cookie, `/documents/${a.cardId}`);
    const res = await post(baseUrl, cookie, `/documents/${a.cardId}/fix`, { text: 'להוסיף מע"מ', csrf });
    expect(res.status).toBe(303);
    expect((await withBusiness(B, (db) => loadDocumentCard(db, a.cardId)))?.state).toBe('superseded');
    const { rows } = await getPool().query<{ n: string }>('SELECT count(*)::text AS n FROM document_productions');
    expect(rows[0]?.n).toBe('2');
  });

  it('another business cannot see or download the card', async () => {
    const a = await card();
    await createOwner({ username: 'other', password: PASSWORD, businessId: 'other-business' });
    await withBusiness('other-business', (bdb) => installCharter(bdb, buildCharter({ version: 'gate-charter' }))); // TENANCY-TODO(task 10)
    server = createServer({ businessId: 'other-business', port: 0 });
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'other', password: PASSWORD }),
      redirect: 'manual',
    });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await get(baseUrl, cookie, `/documents/${a.cardId}`)).status).toBe(404);
    expect((await get(baseUrl, cookie, `/documents/${a.cardId}/download`)).status).toBe(404);
  });
});

describe('/documents/settings', () => {
  it('settings refuse all channels off', async () => {
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const csrf = await csrfOf(baseUrl, cookie, '/documents/settings');
    const res = await post(baseUrl, cookie, '/documents/settings', { csrf, baseFolder: '' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(DOCUMENT_SETTINGS_HE.noChannel);
    expect(await loadDocumentSettings({ businessId: B })).toMatchObject({ toEmail: true, toScreen: true });
  });

  it('saves channels and a base folder', async () => {
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const csrf = await csrfOf(baseUrl, cookie, '/documents/settings');
    const res = await post(baseUrl, cookie, '/documents/settings', { csrf, toScreen: 'on', baseFolder: uploadRoot });
    expect(res.status).toBe(303);
    const saved = await loadDocumentSettings({ businessId: B });
    expect(saved).toMatchObject({ toWhatsApp: false, toEmail: false, toScreen: true });
    expect(saved.baseFolder).not.toBe(null);
  });

  it('a settings POST without CSRF is refused', async () => {
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const res = await post(baseUrl, cookie, '/documents/settings', { csrf: 'forged', toScreen: 'on', baseFolder: '' });
    expect(res.status).toBe(403);
  });
});

describe('typedAddressProblem (C12)', () => {
  it('accepts one plain address and refuses shapes, wildcards and invisible characters', () => {
    expect(typedAddressProblem('  yossi@client.example ')).toBe(null);
    expect(typedAddressProblem('a@b')).not.toBe(null);
    expect(typedAddressProblem('a@b.co, c@d.co')).not.toBe(null);
    expect(typedAddressProblem('a@*.client.example')).not.toBe(null);
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    expect(typedAddressProblem(`yossi@client${rlo}.example`)).not.toBe(null);
    expect(typedAddressProblem(`yo${zwsp}ssi@client.example`)).not.toBe(null);
  });
});

describe('fix round 1 minors', () => {
  it('an over-cap upload is refused, the request is cut off, and nothing is ingested', async () => {
    const baseUrl = await start({ uploadMaxBytes: 1024 });
    const cookie = await login(baseUrl);
    const csrf = await csrfOf(baseUrl, cookie, '/instruct');
    const { body, type } = multipart({ csrf, text: 'x' }, { name: 'big.txt', bytes: Buffer.alloc(400 * 1024, 0x61) });
    const url = new URL(`${baseUrl}/instruct`);
    // Declared length (refused before a byte is read) and chunked (refused mid-stream).
    for (const declared of [true, false]) {
      const { status, text } = await new Promise<{ status: number; text: string }>((resolveIt, reject) => {
        const req = request(
          {
            host: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: { cookie, 'content-type': type, ...(declared ? { 'content-length': String(body.length) } : {}) },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolveIt({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', reject);
          },
        );
        req.on('error', () => undefined); // the server may close the upload mid-body, on purpose
        if (declared) {
          req.end(body);
        } else {
          for (let at = 0; at < body.length; at += 16 * 1024) req.write(body.subarray(at, at + 16 * 1024));
          req.end();
        }
      });
      expect(status, `declared=${declared}`).toBe(413);
      expect(text).toContain('הקובץ גדול');
    }
    const { rows } = await getPool().query('SELECT 1 FROM documents');
    expect(rows).toHaveLength(0);
  });

  it('an unreadable charter refuses the document screens instead of guessing a zone and currency', async () => {
    const a = await card();
    await getPool().query(
      `UPDATE charter_versions SET charter = jsonb_set(charter::jsonb, '{schemaVersion}', to_jsonb('0'::text))
        WHERE business_id = $1`,
      [B],
    );
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const list = await get(baseUrl, cookie, '/documents');
    expect(list.status).toBe(503);
    expect(await list.text()).toContain('לא הצלחתי לקרוא את התקנון');
    const one = await get(baseUrl, cookie, `/documents/${a.cardId}`);
    expect(one.status).toBe(503);
    expect((await withBusiness(B, (db) => loadDocumentCard(db, a.cardId)))?.seenAt).toBe(null);
  });
});
