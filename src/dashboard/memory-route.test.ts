/**
 * `GET /memory` — the owner's read-only window onto what the assistant has
 * recorded on its own initiative (`memory/store.ts`).
 *
 * Two things this file has to prove that a smoke test on the heading alone
 * would not: a row whose `provenance` is not `boss` is labelled as a loaded
 * claim rather than shown as settled fact (the whole reason `provenance` is
 * stored on every row at all — see `memory/store.ts`'s own docblock), and a
 * subject string carrying a bidirectional-override character renders with
 * that character stripped, the same guarantee `escLabel` already gives
 * `original_name` on the readings screen (`server.test.ts`).
 *
 * Session and CSRF setup mirrors `erasure-routes.test.ts`.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob } from '../orchestrator/jobs.js';
import { writeMemory } from '../memory/store.js';
import { createOwner } from './auth.js';
import { createServer } from './server.js';

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

async function loginWithPassword(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    body: new URLSearchParams({ username: USERNAME, password: PASSWORD }),
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  return cookiePair(res.headers.get('set-cookie'));
}

/** A job at a given trust level, so `writeMemory` can stamp its provenance. */
async function jobWithProvenance(provenance: 'boss' | 'unknown_external'): Promise<{ jobId: string }> {
  const bundle = await installCharter(buildCharter({ version: `memory-screen-${provenance}` }), {
    businessId: BUSINESS,
  });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance,
    businessId: BUSINESS,
  });
  return { jobId: job.jobId };
}

describe('GET /memory', () => {
  it('lists what is remembered, labelling external claims', async () => {
    const boss = await jobWithProvenance('boss');
    const external = await jobWithProvenance('unknown_external');

    await writeMemory(
      { jobId: boss.jobId, kind: 'preference', subjectKey: 'general', attribute: 'currency', body: { value: 'ILS' } },
      { businessId: BUSINESS },
    );
    await writeMemory(
      {
        jobId: external.jobId,
        kind: 'chunk',
        subjectKey: RONIT,
        body: { text: `הלקוח החדש הוא ${RONIT}` },
        sourceRef: 'DOC-999',
      },
      { businessId: BUSINESS },
    );

    const baseUrl = await startServer();
    const cookie = await loginWithPassword(baseUrl);

    const res = await fetch(`${baseUrl}/memory`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(RONIT);
    expect(body).toContain('נטען');
  });

  it('refuses without a session', async () => {
    const baseUrl = await startServer();

    const res = await fetch(`${baseUrl}/memory`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('strips bidirectional overrides from a remembered subject and its source', async () => {
    const boss = await jobWithProvenance('boss');
    // U+202E RIGHT-TO-LEFT OVERRIDE, the same payload
    // `document-for-approval`'s and `server.test.ts`'s own bidi tests use.
    // Seeded on BOTH fields `renderMemory` runs through `escLabel`
    // (`subjectKey` and `sourceRef`) — one field alone would leave the other
    // unproven.
    const hostileSubject = 'ronit‮gpj.exe';
    const hostileSource = 'DOC-‮gpj.exe';
    await writeMemory(
      {
        jobId: boss.jobId,
        kind: 'entity',
        subjectKey: hostileSubject,
        body: {},
        sourceRef: hostileSource,
      },
      { businessId: BUSINESS },
    );

    const baseUrl = await startServer();
    const cookie = await loginWithPassword(baseUrl);

    const res = await fetch(`${baseUrl}/memory`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('‮');
    // The override is gone, but the surrounding text it wrapped is not —
    // stripping the control character is not a licence to drop the field.
    expect(body).toContain('ronit');
    expect(body).toContain('gpj.exe');
    expect(body).toContain('DOC-');
  });
});
