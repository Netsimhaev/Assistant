import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness, type BusinessDb } from '../db/pool.js';
import { getApproval } from '../governance/approvals.js';
import { decide } from '../governance/approvals.js';
import { loadJob } from '../orchestrator/jobs.js';
import type { PolicyBundle } from '../domain/policy.js';
import { resetDatabase, testDb } from '../test/db.js';
import { installMailboxCharter } from '../test/mailbox.js';
import {
  CONTACT_CARD_EDIT_REFUSAL,
  CONTACT_CARD_GONE,
  ContactCardBusyError,
  CONTACT_CARD_INSTRUCTION,
  EXTERNAL_FILE_WARNING,
  handleContactCardMessage,
  openContactCards,
  presentContactCard,
  raiseContactCard,
  REPLACED_JOB_REASON,
  type OpenContactCard,
} from './contact-card.js';
import { closeConversation, loadConversation, openOrAppend, type ContactConversation } from './contact-conversations.js';
import { createFakeGateway, type FakeGateway } from './fake-gateway.js';
import type { NormalizedInboundMessage } from './gateway.js';
import { createBossMessenger, type BossMessenger } from './messenger.js';
import { recordInbound } from './store.js';

const BUSINESS = 'test-business';
const PRINCIPAL = '+972500000000';
const KEY = '972501110001';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

interface Harness {
  bundle: PolicyBundle;
  gateway: FakeGateway;
  messenger: BossMessenger;
  conversation: ContactConversation;
}

async function harness(): Promise<Harness> {
  const bundle = await installMailboxCharter(BUSINESS);
  const gateway = createFakeGateway();
  const messenger = createBossMessenger({ gateway, contactId: PRINCIPAL.slice(1), businessId: BUSINESS });
  const { conversation } = await withBusiness(BUSINESS, (db) =>
    openOrAppend(db, { key: KEY, subjectKey: null, kind: 'client', inboundAt: new Date() }),
  );
  // What the contact asked.
  await withBusiness(BUSINESS, (db) =>
    recordInbound(db, {
      providerMessageId: 'wamid.contact-1',
      senderNumber: `+${KEY}`,
      senderKind: 'other',
      body: 'שלום, כמה עולה ההצעה?',
      mediaKind: null,
      providerTimestamp: new Date().toISOString(),
    }),
  );
  return { bundle, gateway, messenger, conversation };
}

async function insertDocument(id: string, source: string, name: string, status = 'extracted'): Promise<void> {
  await testDb().query(
    `INSERT INTO documents (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status)
     VALUES ($1, $2, $3, $4, 'application/pdf', $5, 10, $6, $7)`,
    [id, BUSINESS, source, name, 'a'.repeat(64), `${BUSINESS}/${id}/original.pdf`, status],
  );
}

function raise(h: Harness, body = 'שלום, ההצעה בדרך.', attachDocumentId: string | null = null) {
  return withBusiness(BUSINESS, (db) =>
    raiseContactCard(db, {
      conversation: h.conversation,
      draft: { body, attachDocumentId },
      reasonHe: 'שאלה על מחיר — דורשת אישור',
      sourcesHe: ['הצעת מחיר 4412'],
      bundle: h.bundle,
      contactLabel: 'דנה לוי',
    }),
  );
}

const sendVia = (h: Harness) => async (text: string, jobId: string | null) =>
  (await h.messenger.send({ text, jobId })).ok;

function present(h: Harness, approvalId: string) {
  return withBusiness(BUSINESS, (db) => presentContactCard(db, approvalId, sendVia(h)));
}

let nextId = 0;
async function ownerMsg(
  body: string | null,
  mediaKind: string | null = null,
): Promise<{ msg: NormalizedInboundMessage; storedId: string }> {
  nextId += 1;
  const providerTimestamp = new Date(Date.now() + 2_000).toISOString();
  const msg: NormalizedInboundMessage = {
    providerMessageId: `wamid.owner-${nextId}`,
    senderNumber: PRINCIPAL,
    body,
    mediaKind: mediaKind as NormalizedInboundMessage['mediaKind'],
    providerTimestamp,
  };
  const stored = await withBusiness(BUSINESS, (db) =>
    recordInbound(db, {
      providerMessageId: msg.providerMessageId,
      senderNumber: PRINCIPAL,
      senderKind: 'principal',
      body,
      mediaKind,
      providerTimestamp,
    }),
  );
  if (stored === null) throw new Error('duplicate');
  return { msg, storedId: stored.id };
}

async function cardsFor(storedId: string, providerTimestamp: string): Promise<OpenContactCard[]> {
  return withBusiness(BUSINESS, (db) =>
    openContactCards(db, { excludeMessageId: storedId, inboundAt: providerTimestamp }),
  );
}

async function answer(
  h: Harness,
  body: string | null,
  opts: { mediaKind?: string | null; othersOpen?: number; cards?: OpenContactCard[] } = {},
) {
  const { msg, storedId } = await ownerMsg(body, opts.mediaKind ?? null);
  const cards = opts.cards ?? (await cardsFor(storedId, msg.providerTimestamp));
  return withBusiness(BUSINESS, (db: BusinessDb) =>
    handleContactCardMessage(db, { msg, storedId, cards, messenger: h.messenger, othersOpen: opts.othersOpen ?? 0 }),
  );
}

async function approvalsFor(jobId: string) {
  const { rows } = await testDb().query<{
    approval_id: string;
    state: string;
    proposed_input: Record<string, unknown>;
    edited_input: Record<string, unknown> | null;
  }>(
    `SELECT approval_id, state, proposed_input, edited_input FROM approval_requests
      WHERE business_id = $1 AND job_id = $2 ORDER BY created_at`,
    [BUSINESS, jobId],
  );
  return rows;
}

describe('raiseContactCard', () => {
  it('binds a wa.send_message plan, parks the job and keeps the conversation carded on it', async () => {
    const h = await harness();
    const { jobId, approvalId } = await raise(h);

    const job = await withBusiness(BUSINESS, (db) => loadJob(db, jobId));
    expect(job?.phase).toBe('await_approval');
    expect(job?.provenance).toBe('unknown_external');

    const approval = await withBusiness(BUSINESS, (db) => getApproval(db, approvalId));
    expect(approval?.proposedTool).toBe('wa.send_message');
    expect(approval?.actionClass).toBe('whatsapp.reply');
    expect(approval?.proposedInput).toEqual({
      to: `+${KEY}`,
      body: 'שלום, ההצעה בדרך.',
      conversationId: h.conversation.conversationId,
    });
    expect(approval?.detail).toContain('שלום, כמה עולה ההצעה?');
    expect(approval?.detail).toContain('הצעת מחיר 4412');

    const conv = await withBusiness(BUSINESS, (db) => loadConversation(db, h.conversation.conversationId));
    expect(conv?.state).toBe('carded');
    expect(conv?.cardJobId).toBe(jobId);
  });

  it('a new draft cancels the previous pending card', async () => {
    const h = await harness();
    const first = await raise(h, 'טיוטה ראשונה');
    const second = await raise(h, 'טיוטה שנייה');

    expect((await approvalsFor(first.jobId))[0]?.state).toBe('cancelled');
    expect((await approvalsFor(second.jobId))[0]?.state).toBe('pending');
    const oldJob = await withBusiness(BUSINESS, (db) => loadJob(db, first.jobId));
    expect(oldJob?.phase).toBe('failed');
    const { rows } = await testDb().query(
      `SELECT 1 FROM job_steps WHERE business_id = $1 AND job_id = $2 AND reason = $3`,
      [BUSINESS, first.jobId, REPLACED_JOB_REASON],
    );
    expect(rows).toHaveLength(1);
    const conv = await withBusiness(BUSINESS, (db) => loadConversation(db, h.conversation.conversationId));
    expect(conv?.cardJobId).toBe(second.jobId);
    expect(conv?.state).toBe('carded');
  });

  it('a new draft while the previous card is approved but unsent does not cancel it, fail its job or re-point the conversation', async () => {
    const h = await harness();
    const first = await raise(h, 'ראשונה');
    await present(h, first.approvalId);
    await withBusiness(BUSINESS, (db) => decide(db, first.approvalId, 'approved', { by: 'whatsapp:test', channel: 'whatsapp' }));
    const jobsBefore = await testDb().query('SELECT 1 FROM jobs WHERE business_id = $1', [BUSINESS]);

    await expect(raise(h, 'שנייה')).rejects.toBeInstanceOf(ContactCardBusyError);

    expect((await approvalsFor(first.jobId))[0]?.state).toBe('approved');
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, first.jobId)))?.phase).not.toBe('failed');
    const conv = await withBusiness(BUSINESS, (db) => loadConversation(db, h.conversation.conversationId));
    expect(conv?.cardJobId).toBe(first.jobId);
    const jobsAfter = await testDb().query('SELECT 1 FROM jobs WHERE business_id = $1', [BUSINESS]);
    expect(jobsAfter.rows).toHaveLength(jobsBefore.rows.length);
  });

  it('a new draft while the previous card is pending replaces it', async () => {
    const h = await harness();
    const first = await raise(h, 'ראשונה');
    const second = await raise(h, 'שנייה');
    expect((await approvalsFor(first.jobId))[0]?.state).toBe('cancelled');
    const conv = await withBusiness(BUSINESS, (db) => loadConversation(db, h.conversation.conversationId));
    expect(conv?.cardJobId).toBe(second.jobId);
  });

  it('a new draft while the previous job is already past await_approval is refused', async () => {
    const h = await harness();
    const first = await raise(h, 'ראשונה');
    await testDb().query(`UPDATE jobs SET phase = 'execute' WHERE business_id = $1 AND job_id = $2`, [BUSINESS, first.jobId]);
    await expect(raise(h, 'שנייה')).rejects.toBeInstanceOf(ContactCardBusyError);
    expect((await approvalsFor(first.jobId))[0]?.state).toBe('pending');
  });

  it('a closed conversation leaves no live card: the new approval is cancelled and its job failed', async () => {
    const h = await harness();
    await withBusiness(BUSINESS, (db) => closeConversation(db, h.conversation.conversationId, 'closed'));
    await expect(raise(h, 'טיוטה')).rejects.toThrow(/no longer open/);
    const { rows } = await testDb().query<{ state: string }>(`SELECT state FROM approval_requests WHERE business_id = $1`, [BUSINESS]);
    expect(rows.map((r) => r.state)).toEqual(['cancelled']);
    const jobs = await testDb().query<{ phase: string }>(`SELECT phase FROM jobs WHERE business_id = $1`, [BUSINESS]);
    expect(jobs.rows.map((r) => r.phase)).toEqual(['failed']);
  });

  it('refuses, leaving no job and no card, when the attached document cannot be loaded', async () => {
    const h = await harness();
    await expect(raise(h, 'עם קובץ', 'DOC-MISSING')).rejects.toThrow(/cannot be loaded/);
    const jobs = await testDb().query('SELECT 1 FROM jobs WHERE business_id = $1', [BUSINESS]);
    const approvals = await testDb().query('SELECT 1 FROM approval_requests WHERE business_id = $1', [BUSINESS]);
    expect(jobs.rows).toHaveLength(0);
    expect(approvals.rows).toHaveLength(0);
  });

  it('refuses a document of another business', async () => {
    const h = await harness();
    await testDb().query(
      `INSERT INTO documents (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status)
       VALUES ('DOC-OTHER', 'other-business', 'manual', 'x.pdf', 'application/pdf', $1, 10, 'o/x.pdf', 'extracted')`,
      ['b'.repeat(64)],
    );
    await expect(raise(h, 'עם קובץ', 'DOC-OTHER')).rejects.toThrow(/cannot be loaded/);
  });
});

describe('presentContactCard', () => {
  it('sends who/what/found/why/proposed reply and the instruction line, recorded on the card job', async () => {
    const h = await harness();
    const { jobId, approvalId } = await raise(h);
    expect(await present(h, approvalId)).toBe(true);

    const text = h.gateway.sent.at(-1)?.body ?? '';
    expect(text).toContain('דנה לוי');
    expect(text).toContain(`+${KEY}`);
    expect(text).toContain('לקוח');
    expect(text).toContain('שלום, כמה עולה ההצעה?');
    expect(text).toContain('הצעת מחיר 4412');
    expect(text).toContain('שאלה על מחיר — דורשת אישור');
    expect(text).toContain('שלום, ההצעה בדרך.');
    expect(text.endsWith(CONTACT_CARD_INSTRUCTION)).toBe(true);
    const { rows } = await testDb().query(
      `SELECT 1 FROM whatsapp_messages WHERE business_id = $1 AND direction = 'outbound' AND job_id = $2`,
      [BUSINESS, jobId],
    );
    expect(rows).toHaveLength(1);
    const conv = await withBusiness(BUSINESS, (db) => loadConversation(db, h.conversation.conversationId));
    expect(conv?.cardPresentedAt).not.toBeNull();
  });

  it('presentation not recorded when send fails', async () => {
    const h = await harness();
    const { approvalId } = await raise(h);
    const ok = await withBusiness(BUSINESS, (db) =>
      presentContactCard(db, approvalId, async () => false),
    );
    expect(ok).toBe(false);
    const conv = await withBusiness(BUSINESS, (db) => loadConversation(db, h.conversation.conversationId));
    expect(conv?.cardPresentedAt).toBeNull();
    const { msg, storedId } = await ownerMsg('שלח');
    expect(await cardsFor(storedId, msg.providerTimestamp)).toHaveLength(0);
  });

  it('shows the attachment by stored name, source and received date, never only the id', async () => {
    const h = await harness();
    await insertDocument('DOC-OWN', 'manual', 'מחירון‮.pdf');
    const { approvalId } = await raise(h, 'מצורף מחירון', 'DOC-OWN');
    await present(h, approvalId);
    const text = h.gateway.sent.at(-1)?.body ?? '';
    expect(text).toContain('מחירון.pdf');
    expect(text).not.toContain('‮');
    expect(text).toContain('העלאה ידנית');
    expect(text).toMatch(/התקבל \d{4}-\d{2}-\d{2}/);
    expect(text).not.toContain(EXTERNAL_FILE_WARNING);
    // The dashboard's detail carries it too.
    const approval = await withBusiness(BUSINESS, (db) => getApproval(db, approvalId));
    expect(approval?.detail).toContain('מחירון.pdf');
  });

  it('warns when the attached file came in from outside', async () => {
    const h = await harness();
    await insertDocument('DOC-MAIL', 'mail', 'invoice.pdf', 'stored');
    const { approvalId } = await raise(h, 'מצורף', 'DOC-MAIL');
    await present(h, approvalId);
    const text = h.gateway.sent.at(-1)?.body ?? '';
    expect(text).toContain('invoice.pdf');
    expect(text).toContain(EXTERNAL_FILE_WARNING);
    const approval = await withBusiness(BUSINESS, (db) => getApproval(db, approvalId));
    expect(approval?.detail).toContain(EXTERNAL_FILE_WARNING);
  });
});

describe('answering on WhatsApp', () => {
  it('"שלח" with the one open card approves it on the whatsapp channel', async () => {
    const h = await harness();
    const { jobId, approvalId } = await raise(h);
    await present(h, approvalId);
    expect(await answer(h, '‏ שלח ‎')).toBe('decided');
    expect((await approvalsFor(jobId))[0]?.state).toBe('approved');
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.phase).toBe('execute');
    const conv = await withBusiness(BUSINESS, (db) => loadConversation(db, h.conversation.conversationId));
    expect(conv?.state).toBe('carded');
  });

  it('"שלח" with another open thing is refused and nothing is decided', async () => {
    const h = await harness();
    const { jobId, approvalId } = await raise(h);
    await present(h, approvalId);
    expect(await answer(h, 'שלח', { othersOpen: 1 })).toBe('refused');
    expect((await approvalsFor(jobId))[0]?.state).toBe('pending');
    expect(h.gateway.sent.at(-1)?.body).toContain('יש כמה שאלות פתוחות');
  });

  it('"שלח" after the card was replaced decides nothing', async () => {
    const h = await harness();
    const first = await raise(h, 'ראשונה');
    await present(h, first.approvalId);
    const { msg: m0, storedId: s0 } = await ownerMsg('x');
    const stale = await cardsFor(s0, m0.providerTimestamp);
    expect(stale).toHaveLength(1);

    const second = await raise(h, 'שנייה');
    await present(h, second.approvalId);

    expect(await answer(h, 'שלח', { cards: stale })).toBe('refused');
    expect((await approvalsFor(first.jobId))[0]?.state).toBe('cancelled');
    expect((await approvalsFor(second.jobId))[0]?.state).toBe('pending');
    expect(h.gateway.sent.at(-1)?.body).toBe(CONTACT_CARD_GONE);
  });

  it('"שלח" after the card expired decides nothing', async () => {
    const h = await harness();
    const { jobId, approvalId } = await raise(h);
    await present(h, approvalId);
    const { msg, storedId } = await ownerMsg('x');
    const stale = await cardsFor(storedId, msg.providerTimestamp);
    await testDb().query(
      `UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE approval_id = $1`,
      [approvalId],
    );
    expect(await cardsFor(storedId, msg.providerTimestamp)).toHaveLength(0);
    expect(await answer(h, 'שלח', { cards: stale })).toBe('refused');
    expect((await approvalsFor(jobId))[0]?.state).toBe('pending');
  });

  it('audio or caption never decides', async () => {
    const h = await harness();
    const { jobId, approvalId } = await raise(h);
    await present(h, approvalId);
    expect(await answer(h, null, { mediaKind: 'audio' })).toBe('passthrough');
    expect(await answer(h, 'שלח', { mediaKind: 'image' })).toBe('passthrough');
    expect((await approvalsFor(jobId))[0]?.state).toBe('pending');
  });

  it('other text passes through and the card stays open', async () => {
    const h = await harness();
    const { jobId, approvalId } = await raise(h);
    await present(h, approvalId);
    expect(await answer(h, 'מה השעה?')).toBe('passthrough');
    expect((await approvalsFor(jobId))[0]?.state).toBe('pending');
  });

  it('"נוסח:" raises a new card with only the body changed, on the same job, still carded', async () => {
    const h = await harness();
    const { jobId, approvalId } = await raise(h);
    await present(h, approvalId);
    const original = await withBusiness(BUSINESS, (db) => getApproval(db, approvalId));

    expect(await answer(h, '‏נוסח: שלום דנה, ההצעה תגיע ביום ראשון.')).toBe('replaced');

    const rows = await approvalsFor(jobId);
    expect(rows.map((r) => r.state)).toEqual(['cancelled', 'pending']);
    expect(rows[1]?.proposed_input).toEqual(original?.proposedInput);
    expect(rows[1]?.edited_input).toEqual({
      ...(original?.proposedInput as Record<string, unknown>),
      body: 'שלום דנה, ההצעה תגיע ביום ראשון.',
    });
    const text = h.gateway.sent.at(-1)?.body ?? '';
    expect(text).toContain('שלום דנה, ההצעה תגיע ביום ראשון.');
    expect(text.endsWith(CONTACT_CARD_INSTRUCTION)).toBe(true);
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.phase).toBe('await_approval');
    const conv = await withBusiness(BUSINESS, (db) => loadConversation(db, h.conversation.conversationId));
    expect(conv?.state).toBe('carded');
    expect(conv?.cardJobId).toBe(jobId);

    // A second "שלח" approves exactly the replacement.
    expect(await answer(h, 'שלח')).toBe('decided');
    expect((await approvalsFor(jobId)).map((r) => r.state)).toEqual(['cancelled', 'approved_with_edit']);
  });

  it('"נוסח:" with nothing after it is refused', async () => {
    const h = await harness();
    const { jobId, approvalId } = await raise(h);
    await present(h, approvalId);
    expect(await answer(h, 'נוסח:')).toBe('refused');
    expect((await approvalsFor(jobId))[0]?.state).toBe('pending');
  });
});

describe('timing', () => {
  it('a message dated before or at the presentation neither opens nor decides the card', async () => {
    const h = await harness();
    const { jobId, approvalId } = await raise(h);
    await present(h, approvalId);
    const { rows } = await testDb().query<{ created_at: Date }>(
      `SELECT created_at FROM whatsapp_messages WHERE business_id = $1 AND direction = 'outbound' AND job_id = $2`,
      [BUSINESS, jobId],
    );
    const presented = rows[0]!.created_at;
    for (const ts of [new Date(presented.getTime() - 5_000), presented]) {
      const { storedId } = await ownerMsg('שלח');
      expect(await cardsFor(storedId, ts.toISOString())).toHaveLength(0);
    }
    const { msg, storedId } = await ownerMsg('שלח');
    const early = { ...msg, providerTimestamp: new Date(presented.getTime() - 5_000).toISOString() };
    const cards = await cardsFor(storedId, early.providerTimestamp);
    expect(await withBusiness(BUSINESS, (db) =>
      handleContactCardMessage(db, { msg: early, storedId, cards, messenger: h.messenger, othersOpen: 0 }),
    )).toBe('passthrough');
    expect((await approvalsFor(jobId))[0]?.state).toBe('pending');
  });

  it('a staged edit that changes more than the body gets its own refusal', async () => {
    const h = await harness();
    const { jobId, approvalId } = await raise(h);
    await present(h, approvalId);
    await testDb().query(
      `UPDATE approval_requests SET edited_input = jsonb_set(proposed_input, '{to}', '"+972509999999"') WHERE approval_id = $1`,
      [approvalId],
    );
    expect(await answer(h, 'שלח')).toBe('refused');
    expect(h.gateway.sent.at(-1)?.body).toBe(CONTACT_CARD_EDIT_REFUSAL);
    expect((await approvalsFor(jobId))[0]?.state).toBe('pending');
  });
});
