/**
 * The mailbox poll pass, end to end against the real database: a fake
 * `MailboxClient`, a stub triage and drafter, the real charter plus the
 * signed mailbox amendment, a live `mailbox` binding and a cursor.
 *
 * Every positive assertion below is paired with a count of the stub calls,
 * so a pass that silently skipped a mail cannot pass for one that handled it
 * correctly (CLAUDE.md, "a negative test that holds without the code is not a
 * test").
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePool, getPool } from '../db/pool.js';
import type { MailTriage } from '../domain/mail-triage.js';
import type { PolicyBundle } from '../domain/policy.js';
import { writeKeyState } from '../governance/master-key.js';
import { revokeGrant, writeGrant } from '../governance/oauth-grants.js';
import {
  getCursor,
  setCursor,
  type IncomingMail,
  type MailAttachment,
} from '../mail/inbox-store.js';
import { MAIL_LABELS } from '../mail/mailbox.js';
import type { MailboxClient, MailboxFailure } from '../mail/providers/types.js';
import { MAIL_CARD_INSTRUCTION, renderMailNotice } from '../mail/whatsapp-notice.js';
import type { Triage, TriageOutcome } from '../sdk/mail-triage.js';
import { resetDatabase } from '../test/db.js';
import {
  DRAFT_BODY,
  NOON,
  QUESTION_TRIAGE,
  incomingMail,
  installMailboxCharter,
  mailboxRuntime,
  stubDrafter,
} from '../test/mailbox.js';
import { envCredentials } from './credentials.js';
import { createJob, loadJob, transition } from './jobs.js';
import { oauthCredentials } from './oauth-token.js';
import type { TokenHttp } from './oauth-token.js';
import { pollMailbox, type MailPollResult } from './mail-poll.js';
import type { Runtime } from './runtime.js';

const BUSINESS = 'test-business';

/** Default curation seam: poll tests never reach the real curateWithModel. */
const stubCurator = async (): Promise<{ candidates: [] }> => ({ candidates: [] });

const INVOICE_TRIAGE: MailTriage = {
  categories: ['invoice'],
  summary: 'חשבונית על שירותי ניקיון לחודש אוקטובר',
  isPerson: true,
  invoice: { number: 'INV-17', amountText: '1,200 ₪', dateText: '20/10/2026' },
  replyGist: null,
};

const OTHER_TRIAGE: MailTriage = {
  categories: ['other'],
  summary: 'ניוזלטר שבועי',
  isPerson: false,
  invoice: null,
  replyGist: null,
};

/** A PDF header followed by the binary comment line every real PDF carries. */
const PDF_BYTES = Buffer.from([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x31, 0x20,
]);

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

interface FakeClient {
  client: MailboxClient;
  listCalls: string[];
  ensureCalls: number;
  labelled: { providerMessageId: string; label: string }[];
  fetched: string[];
}

function fakeClient(
  batches: ({ messages: IncomingMail[]; nextCursor: string } | MailboxFailure)[],
  extra: { initialCursor?: string; fetch?: (attachmentId: string) => Buffer | MailboxFailure } = {},
): FakeClient {
  const state: FakeClient = { client: null as unknown as MailboxClient, listCalls: [], ensureCalls: 0, labelled: [], fetched: [] };
  state.client = {
    initialCursor: async () => extra.initialCursor ?? 'C-NEW',
    listSince: async (_token, cursor) => {
      state.listCalls.push(cursor);
      const batch = batches[Math.min(state.listCalls.length - 1, batches.length - 1)];
      return batch ?? { messages: [], nextCursor: cursor };
    },
    fetchAttachment: async (_token, providerMessageId, attachmentId) => {
      state.fetched.push(`${providerMessageId}/${attachmentId}`);
      return extra.fetch !== undefined ? extra.fetch(attachmentId) : PDF_BYTES;
    },
    ensureLabels: async (_token, names) => {
      state.ensureCalls += 1;
      return Object.fromEntries(names.map((n) => [n, `LBL-${n}`]));
    },
    addLabel: async (_token, providerMessageId, labelName) => {
      state.labelled.push({ providerMessageId, label: labelName });
      return true as const;
    },
    sendReply: async () => ({ externalId: 'SENT-1' }),
  };
  return state;
}

function stubTriage(byMessage: Record<string, MailTriage> | MailTriage): Triage & { calls: number } {
  const fn = (async ({ mail }) => {
    fn.calls += 1;
    const triage = 'categories' in byMessage ? (byMessage as MailTriage) : (byMessage as Record<string, MailTriage>)[mail.providerMessageId];
    if (triage === undefined) throw new Error(`no stub triage for ${mail.providerMessageId}`);
    return { status: 'read', triage } satisfies TriageOutcome;
  }) as Triage & { calls: number };
  fn.calls = 0;
  return fn;
}

async function setup(): Promise<{ bundle: PolicyBundle; documentRoot: string }> {
  const bundle = await installMailboxCharter(BUSINESS);
  await setCursor({ provider: 'google', cursor: 'C-0' }, { businessId: BUSINESS });
  const documentRoot = await mkdtemp(join(tmpdir(), 'mail-poll-'));
  return { bundle, documentRoot };
}

function notifier(): { notify: (text: string, jobId: string | null) => Promise<void>; sent: { text: string; jobId: string | null }[] } {
  const sent: { text: string; jobId: string | null }[] = [];
  return { sent, notify: async (text, jobId) => void sent.push({ text, jobId }) };
}

async function mailRows(): Promise<
  { provider_message_id: string; state: string; categories: string[]; labels_applied: string[]; notified_at: Date | null; job_id: string | null; reply_job_id: string | null }[]
> {
  const { rows } = await getPool().query(
    `SELECT provider_message_id, state, categories, labels_applied, notified_at, job_id, reply_job_id
       FROM mail_messages WHERE business_id = $1 ORDER BY received_at, provider_message_id`,
    [BUSINESS],
  );
  return rows;
}

function expectOk(result: MailPollResult | null): MailPollResult {
  if (result === null) throw new Error('expected a poll result, got null');
  return result;
}

describe('renderMailNotice', () => {
  it('names the sender and address, then the category word and the summary, with bidi controls stripped', () => {
    const text = renderMailNotice(
      { fromName: 'דנה‮ לוי', fromAddress: 'dana@client.example', summary: 'שואלת‏ מתי' },
      ['question'],
    );
    expect(text).toBe('📧 דנה לוי <dana@client.example>\nשאלה שמחכה לתשובה: שואלת מתי');
  });

  it('shows only the address when there is no display name, and both words for an invoice with a question', () => {
    const text = renderMailNotice(
      { fromName: null, fromAddress: 'billing@vendor.example', summary: 'חשבונית ושאלה' },
      ['invoice', 'question'],
    );
    expect(text).toBe('📧 billing@vendor.example\nחשבונית · שאלה שמחכה לתשובה: חשבונית ושאלה');
  });
});

describe('pollMailbox', () => {
  it('no mailbox connection returns null', async () => {
    const fake = fakeClient([]);
    // Nothing installed at all.
    expect(await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client })).toBeNull();
    // Charter, amendment and live binding — but no cursor: still not connected.
    await installMailboxCharter(BUSINESS);
    expect(await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client })).toBeNull();
    expect(fake.listCalls).toHaveLength(0);
  });

  it('records, triages, labels an invoice and audits the label without subject or address', async () => {
    const { documentRoot } = await setup();
    const mail = incomingMail({ providerMessageId: 'PM-INV', subject: 'חשבונית אוקטובר סודית', fromAddress: 'billing@vendor.example' });
    const fake = fakeClient([{ messages: [mail], nextCursor: 'C-1' }]);
    const triage = stubTriage(INVOICE_TRIAGE);
    const n = notifier();

    const result = expectOk(
      await pollMailbox({ curator: stubCurator,
        businessId: BUSINESS,
        runtime: mailboxRuntime(fake.client),
        client: fake.client,
        triage,
        drafter: stubDrafter(),
        documentRoot,
        notifyBoss: n.notify,
        now: NOON,
      }),
    );

    expect(result).toMatchObject({ status: 'ok', recorded: 1, triaged: 1, labelled: 1, notified: 1, overCap: 0, failed: 0, drafts: 0 });
    expect(triage.calls).toBe(1);
    expect(fake.ensureCalls).toBe(1);
    expect(fake.labelled).toEqual([{ providerMessageId: 'PM-INV', label: MAIL_LABELS.invoice }]);
    expect((await getCursor({ businessId: BUSINESS }))?.cursor).toBe('C-1');

    const [row] = await mailRows();
    expect(row?.state).toBe('triaged');
    expect(row?.categories).toEqual(['invoice']);
    expect(row?.labels_applied).toEqual([MAIL_LABELS.invoice]);
    expect(row?.notified_at).not.toBeNull();

    // The triage job: the literal provenance, closed through the legal path.
    const job = await loadJob(row?.job_id ?? '', { businessId: BUSINESS });
    expect(job?.provenance).toBe('unknown_external');
    expect(job?.phase).toBe('closed');
    expect(job?.title).toBe(`מייל: ${mail.subject}`);

    const { rows: invoices } = await getPool().query(
      'SELECT supplier_address, invoice_number, amount_text, document_id FROM mail_invoices WHERE business_id = $1',
      [BUSINESS],
    );
    expect(invoices).toEqual([
      { supplier_address: 'billing@vendor.example', invoice_number: 'INV-17', amount_text: '1,200 ₪', document_id: null },
    ]);

    const { rows: audit } = await getPool().query<{ actor: string; kind: string; reason: string; provenance: string; whole: string }>(
      `SELECT actor, kind, reason, provenance, row_to_json(a)::text AS whole
         FROM audit_log a WHERE business_id = $1 AND reason LIKE 'mail_label:%'`,
      [BUSINESS],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: 'intake.triage',
      kind: 'tool_call',
      reason: `mail_label:${MAIL_LABELS.invoice}`,
      provenance: 'unknown_external',
    });
    expect(audit[0]?.whole).not.toContain('חשבונית אוקטובר סודית');
    expect(audit[0]?.whole).not.toContain('billing@vendor.example');

    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]?.text).toContain('billing@vendor.example');
    expect(n.sent[0]?.text).toContain('חשבונית');
  });

  it('automated newsletter: triaged other, no label, no notify', async () => {
    const { documentRoot } = await setup();
    const mail = incomingMail({
      providerMessageId: 'PM-NEWS',
      fromAddress: 'news@shop.example',
      headerFlags: { listUnsubscribe: true, autoSubmitted: false, bulkPrecedence: false },
    });
    const fake = fakeClient([{ messages: [mail], nextCursor: 'C-1' }]);
    // The model says "a person sent an invoice"; the header rule wins.
    const triage = stubTriage(INVOICE_TRIAGE);
    const n = notifier();

    const result = expectOk(
      await pollMailbox({ curator: stubCurator,
        businessId: BUSINESS,
        runtime: mailboxRuntime(fake.client),
        client: fake.client,
        triage,
        drafter: stubDrafter(),
        documentRoot,
        notifyBoss: n.notify,
      }),
    );

    expect(triage.calls).toBe(1);
    expect(result).toMatchObject({ triaged: 1, labelled: 0, notified: 0, failed: 0 });
    expect(fake.labelled).toHaveLength(0);
    expect(n.sent).toHaveLength(0);
    const [row] = await mailRows();
    expect(row?.state).toBe('triaged');
    expect(row?.categories).toEqual(['other']);
    const { rows: invoices } = await getPool().query('SELECT 1 FROM mail_invoices WHERE business_id = $1', [BUSINESS]);
    expect(invoices).toHaveLength(0);
  });

  it('PDF attachment is ingested with source mail and linked on the invoice row', async () => {
    const { documentRoot } = await setup();
    const attachment: MailAttachment = { attachmentId: 'A-1', filename: 'invoice-17.pdf', mediaType: 'application/pdf', size: PDF_BYTES.length };
    const unsupported: MailAttachment = { attachmentId: 'A-2', filename: 'logo.png', mediaType: 'image/png', size: 10 };
    const mail = incomingMail({ providerMessageId: 'PM-PDF', attachments: [unsupported, attachment] });
    const fake = fakeClient([{ messages: [mail], nextCursor: 'C-1' }]);

    expectOk(
      await pollMailbox({ curator: stubCurator,
        businessId: BUSINESS,
        runtime: mailboxRuntime(fake.client),
        client: fake.client,
        triage: stubTriage(INVOICE_TRIAGE),
        drafter: stubDrafter(),
        documentRoot,
      }),
    );

    // The image is not a type ingest supports: never fetched.
    expect(fake.fetched).toEqual(['PM-PDF/A-1']);
    const { rows: docs } = await getPool().query<{ document_id: string; source: string; original_name: string }>(
      'SELECT document_id, source, original_name, status, stored_path FROM documents WHERE business_id = $1',
      [BUSINESS],
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ source: 'mail', original_name: 'invoice-17.pdf', status: 'stored' });
    const { rows: invoices } = await getPool().query<{ document_id: string | null; file_name: string | null }>(
      'SELECT document_id, file_name FROM mail_invoices WHERE business_id = $1',
      [BUSINESS],
    );
    expect(invoices).toEqual([{ document_id: docs[0]?.document_id, file_name: 'invoice-17.pdf' }]);
  });

  it('links every ingested attachment of a document-category mail on the mail row', async () => {
    const { documentRoot } = await setup();
    const pdf = (id: string, name: string): MailAttachment => ({ attachmentId: id, filename: name, mediaType: 'application/pdf', size: PDF_BYTES.length + 1 });
    const mail = incomingMail({ providerMessageId: 'PM-DOCS', attachments: [pdf('A-1', 'offer.pdf'), pdf('A-2', 'terms.pdf')] });
    // Different bytes per attachment, or the two would dedupe into one document.
    const fake = fakeClient([{ messages: [mail], nextCursor: 'C-1' }], {
      fetch: (id) => Buffer.concat([PDF_BYTES, Buffer.from(id.slice(-1))]),
    });
    const documentTriage: MailTriage = { categories: ['document'], summary: 'הצעה ותנאים', isPerson: false, invoice: null, replyGist: null };

    expectOk(
      await pollMailbox({ curator: stubCurator,
        businessId: BUSINESS,
        runtime: mailboxRuntime(fake.client),
        client: fake.client,
        triage: stubTriage(documentTriage),
        drafter: stubDrafter(),
        documentRoot,
      }),
    );

    const { rows } = await getPool().query<{ attachments: MailAttachment[] }>(
      'SELECT attachments FROM mail_messages WHERE business_id = $1 AND provider_message_id = $2',
      [BUSINESS, 'PM-DOCS'],
    );
    const linked = rows[0]?.attachments ?? [];
    expect(linked.map((a) => a.attachmentId)).toEqual(['A-1', 'A-2']);
    const ids = linked.map((a) => a.documentId);
    expect(ids.every((i) => typeof i === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(2);
    const { rows: docs } = await getPool().query<{ document_id: string; status: string }>(
      'SELECT document_id, status FROM documents WHERE business_id = $1',
      [BUSINESS],
    );
    expect(docs.map((d) => d.status)).toEqual(['stored', 'stored']);
    expect(docs.map((d) => d.document_id).sort()).toEqual([...(ids as string[])].sort());
  });

  it('over cap: 3 mails, cap 2 → 2 triaged, 1 over_cap, triage stub called exactly twice', async () => {
    const { documentRoot } = await setup();
    const mails = [1, 2, 3].map((i) =>
      incomingMail({ providerMessageId: `PM-${i}`, receivedAt: `2026-10-21T08:0${i}:00.000Z`, internetMessageId: `<m-${i}@x.example>` }),
    );
    const fake = fakeClient([{ messages: mails, nextCursor: 'C-1' }]);
    const triage = stubTriage(OTHER_TRIAGE);

    const result = expectOk(
      await pollMailbox({ curator: stubCurator,
        businessId: BUSINESS,
        runtime: mailboxRuntime(fake.client),
        client: fake.client,
        triage,
        drafter: stubDrafter(),
        documentRoot,
        readsPerDay: 2,
      }),
    );

    expect(triage.calls).toBe(2);
    expect(result).toMatchObject({ recorded: 3, triaged: 2, overCap: 1 });
    expect((await mailRows()).map((r) => r.state)).toEqual(['triaged', 'triaged', 'over_cap']);
  });

  it('re-poll after a crash between record and settle does not notify or label twice', async () => {
    const { documentRoot } = await setup();
    const mail = incomingMail({ providerMessageId: 'PM-Q' });
    const fake = fakeClient([{ messages: [mail], nextCursor: 'C-1' }]);
    const both: MailTriage = { ...QUESTION_TRIAGE, categories: ['invoice', 'question'], invoice: INVOICE_TRIAGE.invoice };
    const triage = stubTriage(both);
    const drafter = stubDrafter();
    const n = notifier();
    const run = () =>
      pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage, drafter, documentRoot, notifyBoss: n.notify, now: NOON });

    const first = expectOk(await run());
    expect(first).toMatchObject({ labelled: 2, notified: 1, drafts: 1 });
    expect(fake.labelled).toHaveLength(2);

    // The crash: state back to `received`, but `notified_at`, `labels_applied`
    // and `reply_job_id` were already written.
    await getPool().query("UPDATE mail_messages SET state = 'received', triaged_at = NULL WHERE business_id = $1", [BUSINESS]);

    const second = expectOk(await run());
    expect(triage.calls).toBe(2); // it really was handled a second time
    expect(second).toMatchObject({ triaged: 1, labelled: 0, notified: 0, drafts: 0 });
    expect(fake.labelled).toHaveLength(2);
    // The notice and the reply card, each once: the second handling sends neither.
    expect(n.sent).toHaveLength(2);
    expect(n.sent[1]?.text.endsWith(MAIL_CARD_INSTRUCTION)).toBe(true);
    expect(drafter.calls).toBe(1);
    const { rows: invoices } = await getPool().query('SELECT 1 FROM mail_invoices WHERE business_id = $1', [BUSINESS]);
    expect(invoices).toHaveLength(1);
    const { rows: labelAudits } = await getPool().query(
      "SELECT 1 FROM audit_log WHERE business_id = $1 AND reason LIKE 'mail_label:%'",
      [BUSINESS],
    );
    expect(labelAudits).toHaveLength(2);
  });

  it('a question from a person raises a reply card and links it on the mail', async () => {
    const { documentRoot } = await setup();
    const fake = fakeClient([{ messages: [incomingMail({ providerMessageId: 'PM-Q' })], nextCursor: 'C-1' }]);
    const drafter = stubDrafter();

    const result = expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage: stubTriage(QUESTION_TRIAGE), drafter, documentRoot, now: NOON }),
    );

    expect(result).toMatchObject({ drafts: 1, labelled: 1, unnotified: 1 });
    expect(drafter.calls).toBe(1);
    const [row] = await mailRows();
    expect(row?.reply_job_id).not.toBeNull();
    expect((await loadJob(row?.reply_job_id ?? '', { businessId: BUSINESS }))?.phase).toBe('await_approval');
  });

  it('a question presents its reply card on WhatsApp, against the reply job, right after the notice', async () => {
    const { documentRoot } = await setup();
    const fake = fakeClient([{ messages: [incomingMail({ providerMessageId: 'PM-Q' })], nextCursor: 'C-1' }]);
    const n = notifier();

    const result = expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage: stubTriage(QUESTION_TRIAGE), drafter: stubDrafter(), documentRoot, notifyBoss: n.notify, now: NOON }),
    );

    expect(result).toMatchObject({ drafts: 1, notified: 1 });
    const [row] = await mailRows();
    expect(n.sent).toHaveLength(2);
    const card = n.sent[1];
    expect(card?.jobId).toBe(row?.reply_job_id);
    expect(card?.text).toContain('dana@client.example');
    expect(card?.text).toContain(DRAFT_BODY);
    expect(card?.text.endsWith(MAIL_CARD_INSTRUCTION)).toBe(true);
  });

  it('without a WhatsApp bridge nothing is presented and the notice is counted unnotified', async () => {
    const { documentRoot } = await setup();
    const fake = fakeClient([{ messages: [incomingMail({ providerMessageId: 'PM-Q' })], nextCursor: 'C-1' }]);

    const result = expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage: stubTriage(QUESTION_TRIAGE), drafter: stubDrafter(), documentRoot, now: NOON }),
    );

    expect(result).toMatchObject({ drafts: 1, notified: 0, unnotified: 1 });
    const { rows } = await getPool().query(
      "SELECT 1 FROM whatsapp_messages WHERE business_id = $1 AND direction = 'outbound'",
      [BUSINESS],
    );
    expect(rows).toHaveLength(0);
  });

  it('an empty sender is never notified', async () => {
    const { documentRoot } = await setup();
    const fake = fakeClient([{ messages: [incomingMail({ providerMessageId: 'PM-X', fromAddress: '' })], nextCursor: 'C-1' }]);
    const n = notifier();

    const result = expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage: stubTriage(INVOICE_TRIAGE), drafter: stubDrafter(), documentRoot, notifyBoss: n.notify }),
    );

    expect(result).toMatchObject({ triaged: 1, notified: 0 });
    expect(n.sent).toHaveLength(0);
  });

  it('a triage that throws fails that mail only and the pass continues', async () => {
    const { documentRoot } = await setup();
    const mails = [
      incomingMail({ providerMessageId: 'PM-BAD', receivedAt: '2026-10-21T08:01:00.000Z' }),
      incomingMail({ providerMessageId: 'PM-GOOD', receivedAt: '2026-10-21T08:02:00.000Z' }),
    ];
    const fake = fakeClient([{ messages: mails, nextCursor: 'C-1' }]);
    const triage = stubTriage({ 'PM-GOOD': OTHER_TRIAGE });

    const result = expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage, drafter: stubDrafter(), documentRoot }),
    );

    expect(triage.calls).toBe(2);
    expect(result).toMatchObject({ status: 'ok', failed: 1 });
    const rows = await mailRows();
    expect(rows.map((r) => [r.provider_message_id, r.state])).toEqual([
      ['PM-BAD', 'failed'],
      ['PM-GOOD', 'triaged'],
    ]);
    expect((await loadJob(rows[0]?.job_id ?? '', { businessId: BUSINESS }))?.phase).toBe('failed');
  });

  it('revoked grant gives needs_reauth and does not throw', async () => {
    const { documentRoot } = await setup();
    const key = randomBytes(32);
    await writeKeyState(key, 'KEY-test');
    await writeGrant(
      {
        businessId: BUSINESS,
        system: 'mailbox',
        provider: 'google',
        credentialRef: 'OAUTH_MAILBOX',
        account: 'owner@business.example',
        scopes: ['https://www.googleapis.com/auth/gmail.modify'],
        refreshToken: 'refresh-token-value',
        grantedBy: 'owner',
      },
      key,
    );
    await revokeGrant('mailbox', BUSINESS, 'owner');
    const neverCalled: TokenHttp = {
      exchangeRefresh: async () => {
        throw new Error('the token endpoint must not be reached for a revoked grant');
      },
    } as unknown as TokenHttp;
    const fake = fakeClient([{ messages: [incomingMail()], nextCursor: 'C-1' }]);
    const runtime: Runtime = {
      ...mailboxRuntime(fake.client),
      credentials: oauthCredentials({ key, fallback: envCredentials({}, 'TEST_CRED_'), http: neverCalled }),
    };

    const result = await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime, client: fake.client, triage: stubTriage(OTHER_TRIAGE), drafter: stubDrafter(), documentRoot });

    expect(result?.status).toBe('needs_reauth');
    expect(fake.listCalls).toHaveLength(0);
    const cursor = await getCursor({ businessId: BUSINESS });
    expect(cursor?.cursor).toBe('C-0');
    expect(cursor?.lastError).toBe('needs_reauth');
  });

  it('cursor advances only after recording', async () => {
    const { documentRoot } = await setup();
    const third = incomingMail({ providerMessageId: 'PM-3' });
    Object.defineProperty(third, 'subject', {
      get() {
        throw new Error('mapping failed on the third message');
      },
    });
    const fake = fakeClient([
      { messages: [incomingMail({ providerMessageId: 'PM-1' }), incomingMail({ providerMessageId: 'PM-2' }), third], nextCursor: 'C-1' },
    ]);
    const triage = stubTriage(OTHER_TRIAGE);

    const result = expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage, drafter: stubDrafter(), documentRoot }),
    );

    expect(result.status).toBe('error');
    expect(result.recorded).toBe(2);
    expect((await mailRows()).map((r) => r.provider_message_id)).toEqual(['PM-1', 'PM-2']);
    const cursor = await getCursor({ businessId: BUSINESS });
    expect(cursor?.cursor).toBe('C-0');
    expect(cursor?.lastError).not.toBeNull();
    // Fix round 1: a record failure no longer stalls everything already stored.
    expect(triage.calls).toBe(2);
  });

  it('one message that cannot be recorded becomes a placeholder on its third failing pass, and the cursor moves', async () => {
    const { documentRoot } = await setup();
    const broken = incomingMail({ providerMessageId: 'PM-BROKEN' });
    Object.defineProperty(broken, 'subject', {
      get() {
        throw new Error('unmappable');
      },
    });
    const fake = fakeClient([{ messages: [incomingMail({ providerMessageId: 'PM-OK' }), broken], nextCursor: 'C-1' }]);
    const run = () =>
      pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage: stubTriage(OTHER_TRIAGE), drafter: stubDrafter(), documentRoot });

    for (const _ of [1, 2]) {
      expect(expectOk(await run()).status).toBe('error');
      expect((await getCursor({ businessId: BUSINESS }))?.cursor).toBe('C-0');
    }
    const third = expectOk(await run());
    expect(third.status).toBe('ok');
    expect((await getCursor({ businessId: BUSINESS }))?.cursor).toBe('C-1');
    const { rows } = await getPool().query<{ state: string; error: string | null; subject: string }>(
      "SELECT state, error, subject FROM mail_messages WHERE provider_message_id = 'PM-BROKEN'",
    );
    expect(rows).toEqual([{ state: 'failed', error: 'unrecordable', subject: '(לא ניתן לשמור את המייל)' }]);
  });

  it('a mail carrying NUL bytes is recorded and triaged rather than stalling the poll', async () => {
    const { documentRoot } = await setup();
    const mail = incomingMail({ providerMessageId: 'PM-NUL', subject: 'x\u0000y', bodyText: 'a\u0000b' });
    const fake = fakeClient([{ messages: [mail], nextCursor: 'C-1' }]);

    const result = expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage: stubTriage(OTHER_TRIAGE), drafter: stubDrafter(), documentRoot }),
    );

    expect(result).toMatchObject({ status: 'ok', recorded: 1, triaged: 1 });
    expect((await getCursor({ businessId: BUSINESS }))?.cursor).toBe('C-1');
  });

  it('a failed attachment fetch keeps the notice, the invoice row (without a document) and the card', async () => {
    const { documentRoot } = await setup();
    const attachment: MailAttachment = { attachmentId: 'A-1', filename: 'invoice.pdf', mediaType: 'application/pdf', size: 100 };
    const fake = fakeClient([{ messages: [incomingMail({ providerMessageId: 'PM-AF', attachments: [attachment] })], nextCursor: 'C-1' }], {
      fetch: () => ({ failure: 'transient', status: 503, message: 'unavailable' }),
    });
    const n = notifier();
    const both: MailTriage = { ...QUESTION_TRIAGE, categories: ['invoice', 'question'], invoice: INVOICE_TRIAGE.invoice };

    const result = expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage: stubTriage(both), drafter: stubDrafter(), documentRoot, notifyBoss: n.notify, now: NOON }),
    );

    expect(fake.fetched).toEqual(['PM-AF/A-1']);
    expect(result).toMatchObject({ failed: 0, notified: 1, drafts: 1 });
    const { rows } = await getPool().query<{ state: string; error: string | null }>("SELECT state, error FROM mail_messages WHERE provider_message_id = 'PM-AF'");
    expect(rows).toEqual([{ state: 'triaged', error: 'attachment_failed' }]);
    const { rows: invoices } = await getPool().query('SELECT document_id FROM mail_invoices WHERE business_id = $1', [BUSINESS]);
    expect(invoices).toEqual([{ document_id: null }]);
  });

  it('skips an attachment over 25 MB without downloading it, and takes at most 10 per mail', async () => {
    const { documentRoot } = await setup();
    const huge: MailAttachment = { attachmentId: 'BIG', filename: 'huge.pdf', mediaType: 'application/pdf', size: 26 * 1024 * 1024 };
    const many: MailAttachment[] = Array.from({ length: 12 }, (_, i) => ({
      attachmentId: `A-${i}`,
      filename: `p${i}.pdf`,
      mediaType: 'application/pdf',
      size: 100,
    }));
    const fake = fakeClient(
      [
        { messages: [incomingMail({ providerMessageId: 'PM-BIG', attachments: [huge] }), incomingMail({ providerMessageId: 'PM-MANY', receivedAt: '2026-10-21T08:30:00.000Z', attachments: many })], nextCursor: 'C-1' },
      ],
      // Distinct bytes per attachment, so dedupe by hash cannot hide a fetch.
      { fetch: (id) => Buffer.concat([PDF_BYTES, Buffer.from(id)]) },
    );

    expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage: stubTriage(OTHER_TRIAGE), drafter: stubDrafter(), documentRoot }),
    );

    expect(fake.fetched.filter((f) => f.startsWith('PM-BIG'))).toEqual([]);
    expect(fake.fetched.filter((f) => f.startsWith('PM-MANY'))).toHaveLength(10);
    const { rows } = await getPool().query<{ error: string | null }>("SELECT error FROM mail_messages WHERE provider_message_id = 'PM-BIG'");
    expect(rows[0]?.error).toBe('attachment_too_large');
  });

  it('accepts an octet-stream attachment named .pdf and lets the bytes decide', async () => {
    const { documentRoot } = await setup();
    const attachment: MailAttachment = { attachmentId: 'A-1', filename: 'scan.pdf', mediaType: 'application/octet-stream', size: PDF_BYTES.length };
    const other: MailAttachment = { attachmentId: 'A-2', filename: 'data.bin', mediaType: 'application/octet-stream', size: 4 };
    const fake = fakeClient([{ messages: [incomingMail({ providerMessageId: 'PM-OCT', attachments: [attachment, other] })], nextCursor: 'C-1' }]);

    expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage: stubTriage(OTHER_TRIAGE), drafter: stubDrafter(), documentRoot }),
    );

    expect(fake.fetched).toEqual(['PM-OCT/A-1']);
    const { rows } = await getPool().query<{ status: string; media_type: string }>('SELECT status, media_type FROM documents WHERE business_id = $1', [BUSINESS]);
    expect(rows).toEqual([{ status: 'stored', media_type: 'application/pdf' }]);
  });

  it('returns a stale claim to received and fails its orphaned triage job before re-handling', async () => {
    const { bundle, documentRoot } = await setup();
    const fake = fakeClient([{ messages: [incomingMail({ providerMessageId: 'PM-STALE' })], nextCursor: 'C-1' }]);
    // A first pass whose triage is never reached: simulate the crash by hand.
    await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage: stubTriage(OTHER_TRIAGE), drafter: stubDrafter(), documentRoot, readsPerDay: 1 });
    const orphan = await createJob({ charterVersion: bundle.charterVersion, provenance: 'unknown_external', businessId: BUSINESS, title: 'orphan' });
    await transition(orphan.jobId, { to: 'understand', actor: 'orchestrator', reason: 'test', businessId: BUSINESS });
    await getPool().query(
      `UPDATE mail_messages SET state = 'claimed', triaged_at = NULL, job_id = $2, claimed_at = now() - interval '31 minutes'
        WHERE business_id = $1`,
      [BUSINESS, orphan.jobId],
    );
    const triage = stubTriage(OTHER_TRIAGE);

    const result = expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage, drafter: stubDrafter(), documentRoot }),
    );

    expect(triage.calls).toBe(1);
    expect(result.triaged).toBe(1);
    expect((await loadJob(orphan.jobId, { businessId: BUSINESS }))?.phase).toBe('failed');
    const [row] = await mailRows();
    expect(row?.state).toBe('triaged');
    expect(row?.job_id).not.toBe(orphan.jobId);
  });

  it('a fresh claim (under 30 minutes) is left alone', async () => {
    const { documentRoot } = await setup();
    const fake = fakeClient([{ messages: [incomingMail({ providerMessageId: 'PM-FRESH' })], nextCursor: 'C-1' }]);
    await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage: stubTriage(OTHER_TRIAGE), drafter: stubDrafter(), documentRoot, readsPerDay: 1 });
    await getPool().query("UPDATE mail_messages SET state = 'claimed', triaged_at = NULL, claimed_at = now() - interval '5 minutes' WHERE business_id = $1", [BUSINESS]);
    const triage = stubTriage(OTHER_TRIAGE);

    await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage, drafter: stubDrafter(), documentRoot });

    expect(triage.calls).toBe(0);
    expect((await mailRows())[0]?.state).toBe('claimed');
  });

  it('triages at most 20 mails in one pass by default', async () => {
    const { documentRoot } = await setup();
    const mails = Array.from({ length: 21 }, (_, i) =>
      incomingMail({ providerMessageId: `PM-${String(i).padStart(2, '0')}`, receivedAt: new Date(Date.UTC(2026, 9, 21, 8, i)).toISOString() }),
    );
    const fake = fakeClient([{ messages: mails, nextCursor: 'C-1' }]);
    const triage = stubTriage(OTHER_TRIAGE);

    const result = expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage, drafter: stubDrafter(), documentRoot }),
    );

    expect(triage.calls).toBe(20);
    expect(result).toMatchObject({ recorded: 21, triaged: 20 });
  });

  it('a close that throws after the mail settled leaves it triaged, not failed', async () => {
    const { documentRoot } = await setup();
    const fake = fakeClient([{ messages: [incomingMail({ providerMessageId: 'PM-CLOSE' })], nextCursor: 'C-1' }]);
    // The triage stub moves the triage job to `failed` behind the poller's
    // back, so the poller's own `plan` transition is illegal and throws.
    const triage: Triage = async () => {
      const { rows } = await getPool().query<{ job_id: string }>(
        "SELECT job_id FROM jobs WHERE business_id = $1 AND title LIKE 'מייל:%' ORDER BY created_at DESC LIMIT 1",
        [BUSINESS],
      );
      const jobId = rows[0]?.job_id;
      if (jobId === undefined) throw new Error('no triage job');
      await transition(jobId, { to: 'failed', actor: 'orchestrator', reason: 'test', businessId: BUSINESS });
      return { status: 'read', triage: OTHER_TRIAGE };
    };

    const result = expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage, drafter: stubDrafter(), documentRoot }),
    );

    expect(result.failed).toBe(0);
    const [row] = await mailRows();
    expect(row?.state).toBe('triaged');
    expect(row?.categories).toEqual(['other']);
  });

  it('a transient listing failure reports an error and keeps the cursor', async () => {
    const { documentRoot } = await setup();
    const fake = fakeClient([{ failure: 'transient', status: 503, message: 'mailbox provider unavailable (503)' }]);

    const result = expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage: stubTriage(OTHER_TRIAGE), drafter: stubDrafter(), documentRoot }),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('503');
    expect((await getCursor({ businessId: BUSINESS }))?.cursor).toBe('C-0');
  });

  it('an auth failure on listing reports needs_reauth', async () => {
    const { documentRoot } = await setup();
    const fake = fakeClient([{ failure: 'auth', status: 401, message: 'mailbox auth rejected (401)' }]);

    const result = await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage: stubTriage(OTHER_TRIAGE), drafter: stubDrafter(), documentRoot });

    expect(result?.status).toBe('needs_reauth');
    expect((await getCursor({ businessId: BUSINESS }))?.cursor).toBe('C-0');
  });

  it('an expired cursor is re-taken with a gap flag and no backfill', async () => {
    const { documentRoot } = await setup();
    const fake = fakeClient([{ failure: 'cursor_expired', status: 404, message: 'mailbox cursor expired (404): gone' }], { initialCursor: 'C-FRESH' });
    const triage = stubTriage(OTHER_TRIAGE);

    const result = expectOk(
      await pollMailbox({ curator: stubCurator, businessId: BUSINESS, runtime: mailboxRuntime(fake.client), client: fake.client, triage, drafter: stubDrafter(), documentRoot }),
    );

    expect(result).toMatchObject({ status: 'ok', gap: true, recorded: 0 });
    expect(fake.listCalls).toEqual(['C-0']);
    const cursor = await getCursor({ businessId: BUSINESS });
    expect(cursor?.cursor).toBe('C-FRESH');
    expect(cursor?.lastError).toBe('cursor_expired_gap');

    // Durable: the next clean pass overwrites `last_error`, the audit row stays.
    const { rows: gapRows } = await getPool().query<{ reason: string; whole: string }>(
      "SELECT reason, row_to_json(a)::text AS whole FROM audit_log a WHERE business_id = $1 AND reason = 'mail_cursor_gap'",
      [BUSINESS],
    );
    expect(gapRows).toHaveLength(1);
    expect(gapRows[0]?.whole).not.toContain('C-0');
  });
});
