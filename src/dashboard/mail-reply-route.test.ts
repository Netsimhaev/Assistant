/**
 * The decide route on a mailbox-reply card (fix round 1).
 *
 * Ruling: the recipient of a mailbox reply is always the original From. The
 * owner may edit the subject and the body; an edit that changes the recipient
 * or any threading field is refused, the approval stays pending, and nothing
 * is sent. Someone who wants to write to another person uses the instruction
 * door.
 *
 * Each refusal is paired with the body-only edit that IS accepted and sent,
 * through the same route and the same scheduler run — so the refusal tests
 * cannot pass merely because this route never approves anything.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  NOON,
  QUESTION_TRIAGE,
  fakeMailboxClient,
  installMailboxCharter,
  mailboxRuntime,
  storedMail,
  stubDrafter,
} from '../test/mailbox.js';
import { getApproval } from '../governance/approvals.js';
import { loadJob } from '../orchestrator/jobs.js';
import { raiseMailReply } from '../orchestrator/mail-reply.js';
import { runDueJobs } from '../orchestrator/run-due.js';
import { createOwner } from './auth.js';
import { createServer } from './server.js';

const BUSINESS = 'test-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';
const REFUSAL = 'בתשובה למייל אפשר לערוך רק את הנושא ואת גוף ההודעה';
const OUTLOOK_REFUSAL = 'ב-Outlook הנושא נקבע אוטומטית — אפשר לערוך רק את גוף ההודעה';
const OUTLOOK_SUBJECT_NOTE = 'ב-Outlook הנושא נקבע אוטומטית';

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
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    body: new URLSearchParams({ username: USERNAME, password: PASSWORD }),
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  const pair = res.headers.get('set-cookie')?.split(';')[0];
  if (!pair) throw new Error('no session cookie');
  return pair;
}

function csrfOf(html: string): string {
  const match = /name="csrf" value="([0-9a-f]+)"/.exec(html);
  if (!match?.[1]) throw new Error('no csrf token');
  return match[1];
}

async function setup(provider: 'google' | 'microsoft' = 'google') {
  const bundle = await installMailboxCharter(BUSINESS, provider);
  const mail = await storedMail(BUSINESS);
  const raised = await raiseMailReply(
    { mail, triage: QUESTION_TRIAGE, bundle, drafter: stubDrafter() },
    { businessId: BUSINESS },
  );
  if (raised === null) throw new Error('expected a card');
  const approval = await getApproval(raised.approvalId, { businessId: BUSINESS });
  const proposed = approval?.proposedInput as Record<string, unknown>;
  const baseUrl = await startServer();
  const cookie = await login(baseUrl);
  const card = await fetch(`${baseUrl}/a/${raised.approvalId}`, { headers: { cookie } });
  const html = await card.text();
  return { raised, proposed, baseUrl, cookie, html, csrf: csrfOf(html) };
}

async function submit(s: Awaited<ReturnType<typeof setup>>, edited: unknown): Promise<Response> {
  return fetch(`${s.baseUrl}/a/${s.raised.approvalId}/approve`, {
    method: 'POST',
    headers: { cookie: s.cookie },
    body: new URLSearchParams({ csrf: s.csrf, input: JSON.stringify(edited) }),
    redirect: 'manual',
  });
}

async function runAndCollect() {
  const { client, sent } = fakeMailboxClient();
  await runDueJobs({ businessId: BUSINESS, runtime: mailboxRuntime(client), now: NOON });
  return sent;
}

describe('editing a mailbox-reply card', () => {
  it('the card itself renders as a mail reply (recipient row)', async () => {
    const s = await setup();
    expect(s.html).toContain('נמען התשובה');
  });

  it('a changed `to` is refused, the approval stays pending, and nothing is sent', async () => {
    const s = await setup();
    const res = await submit(s, { ...s.proposed, to: ['someone-else@other.example'] });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(REFUSAL);
    expect((await getApproval(s.raised.approvalId, { businessId: BUSINESS }))?.state).toBe('pending');
    expect((await loadJob(s.raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('await_approval');
    expect(await runAndCollect()).toHaveLength(0);
  });

  it('a removed `inReplyTo` is refused', async () => {
    const s = await setup();
    const { inReplyTo: _dropped, ...rest } = s.proposed;
    const res = await submit(s, rest);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(REFUSAL);
    expect((await getApproval(s.raised.approvalId, { businessId: BUSINESS }))?.state).toBe('pending');
  });

  it('an added field is refused', async () => {
    const s = await setup();
    const res = await submit(s, { ...s.proposed, cc: ['boss@business.example'] });
    expect(res.status).toBe(400);
    expect((await getApproval(s.raised.approvalId, { businessId: BUSINESS }))?.state).toBe('pending');
  });

  it('on Gmail the card says nothing about the subject being set by the provider', async () => {
    const s = await setup('google');
    expect(s.html).not.toContain(OUTLOOK_SUBJECT_NOTE);
  });

  it('a body-and-subject edit is accepted and sent', async () => {
    const s = await setup();
    const res = await submit(s, { ...s.proposed, subject: 'Re: נושא ערוך', body: 'גוף ערוך' });
    expect(res.status).toBe(302);
    expect((await getApproval(s.raised.approvalId, { businessId: BUSINESS }))?.state).toBe('approved_with_edit');
    const sent = await runAndCollect();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe('גוף ערוך');
    expect(sent[0]?.subject).toBe('Re: נושא ערוך');
    expect(sent[0]?.to).toEqual(['dana@client.example']);
  });
});

describe('a Microsoft 365 mailbox sets the reply subject itself (R22)', () => {
  // Graph's /reply ignores a subject: Outlook writes "RE: <original>". An
  // accepted subject edit would be a change the owner approved and that never
  // happened, so it is refused — and the card says so up front.

  it('the card says the subject is set by Outlook', async () => {
    const s = await setup('microsoft');
    expect(s.html).toContain(OUTLOOK_SUBJECT_NOTE);
  });

  it('a subject edit is refused with the Outlook reason, the approval stays pending, nothing is sent', async () => {
    const s = await setup('microsoft');
    const res = await submit(s, { ...s.proposed, subject: 'Re: נושא ערוך', body: 'גוף ערוך' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(OUTLOOK_REFUSAL);
    expect((await getApproval(s.raised.approvalId, { businessId: BUSINESS }))?.state).toBe('pending');
    expect(await runAndCollect()).toHaveLength(0);
  });

  it('a body-only edit is accepted and sent (the refusal is about the subject, not every edit)', async () => {
    const s = await setup('microsoft');
    const res = await submit(s, { ...s.proposed, body: 'גוף ערוך' });
    expect(res.status).toBe(302);
    expect((await getApproval(s.raised.approvalId, { businessId: BUSINESS }))?.state).toBe('approved_with_edit');
    const sent = await runAndCollect();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe('גוף ערוך');
  });

  it('a recipient edit on Microsoft still gets the general refusal', async () => {
    const s = await setup('microsoft');
    const res = await submit(s, { ...s.proposed, to: ['someone-else@other.example'] });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(REFUSAL);
  });
});
