import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { decide } from '../governance/approvals.js';
import { resetDatabase, testDb } from '../test/db.js';
import { installMailboxCharter } from '../test/mailbox.js';
import type { PolicyBundle } from '../domain/policy.js';
import { presentContactCard, raiseContactCard } from './contact-card.js';
import { contactHousekeeping, sourceTiersFromDetail, CARD_REMINDER_LEAD } from './contact-housekeeping.js';
import { loadConversation, openOrAppend, type ContactConversation } from './contact-conversations.js';
import { createFakeGateway, type FakeGateway } from './fake-gateway.js';
import { createBossMessenger, type BossMessenger } from './messenger.js';

const BUSINESS = 'test-business';
const PRINCIPAL = '+972500000000';
const KEY = '972501110001';
const HOUR = 3_600_000;

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
  return { bundle, gateway, messenger, conversation };
}

function raise(h: Harness, body = 'שלום, ההצעה בדרך.') {
  return withBusiness(BUSINESS, (db) =>
    raiseContactCard(db, {
      conversation: h.conversation,
      draft: { body, attachDocumentId: null },
      reasonHe: 'שאלה על מחיר — דורשת אישור',
      sourcesHe: ['הצעת מחיר 4412', 'מסמכים פנימיים'],
      bundle: h.bundle,
      contactLabel: 'דנה לוי',
    }),
  );
}

function present(h: Harness, approvalId: string) {
  return withBusiness(BUSINESS, (db) =>
    presentContactCard(db, approvalId, async (text, jobId) => (await h.messenger.send({ text, jobId })).ok),
  );
}

async function cardPresentedAgo(h: Harness, ms: number): Promise<void> {
  await testDb().query(
    `UPDATE contact_conversations SET card_presented_at = $3 WHERE business_id = $1 AND conversation_id = $2`,
    [BUSINESS, h.conversation.conversationId, new Date(Date.now() - ms)],
  );
}

function run(h: Harness, now = new Date()) {
  return withBusiness(BUSINESS, (db) => contactHousekeeping(db, { messenger: h.messenger, now }));
}

const state = async (h: Harness): Promise<string | undefined> =>
  (await withBusiness(BUSINESS, (db) => loadConversation(db, h.conversation.conversationId)))?.state;

async function setPhase(jobId: string, phase: string): Promise<void> {
  await testDb().query('UPDATE jobs SET phase = $3 WHERE business_id = $1 AND job_id = $2', [BUSINESS, jobId, phase]);
}

describe('contact housekeeping', () => {
  it('reminds the owner after 5 hours, exactly once, through the card path', async () => {
    const h = await harness();
    const card = await raise(h);
    await present(h, card.approvalId);
    await cardPresentedAgo(h, 5 * HOUR + 60_000);
    const before = h.gateway.sent.length;

    expect((await run(h)).reminded).toBe(1);
    expect(h.gateway.sent.length).toBe(before + 1);
    expect(h.gateway.sent[before]?.body.startsWith(CARD_REMINDER_LEAD)).toBe(true);
    expect(h.gateway.sent[before]?.body).toContain('שלח');

    await cardPresentedAgo(h, 6 * HOUR);
    expect((await run(h)).reminded).toBe(0);
    expect(h.gateway.sent.length).toBe(before + 1);
  });

  it('sends no reminder at 4h59m', async () => {
    const h = await harness();
    const card = await raise(h);
    await present(h, card.approvalId);
    await cardPresentedAgo(h, 5 * HOUR - 60_000);
    const before = h.gateway.sent.length;
    expect((await run(h)).reminded).toBe(0);
    expect(h.gateway.sent.length).toBe(before);
  });

  it('reminds on a card that has no draft', async () => {
    const h = await harness();
    const card = await raise(h, '');
    await present(h, card.approvalId);
    await cardPresentedAgo(h, 6 * HOUR);
    const before = h.gateway.sent.length;
    expect((await run(h)).reminded).toBe(1);
    expect(h.gateway.sent[before]?.body).toContain('(לא נוסחה הצעה)');
  });

  it('records each decision once: right for approved, wrong for denied', async () => {
    const h = await harness();
    const first = await raise(h, 'א');
    await withBusiness(BUSINESS, (db) => decide(db, first.approvalId, 'approved', { by: 'whatsapp:test', channel: 'whatsapp' }));
    expect((await run(h)).decisionsRecorded).toBe(1);
    expect((await run(h)).decisionsRecorded).toBe(0);
    await setPhase(first.jobId, 'closed');
    await testDb().query(
      `UPDATE contact_conversations SET state = 'closed' WHERE business_id = $1 AND conversation_id = $2`,
      [BUSINESS, h.conversation.conversationId],
    );
    const again = await withBusiness(BUSINESS, (db) =>
      openOrAppend(db, { key: KEY, subjectKey: null, kind: 'client', inboundAt: new Date() }),
    );
    const h2 = { ...h, conversation: again.conversation };
    const second = await raise(h2, 'ב');
    await withBusiness(BUSINESS, (db) => decide(db, second.approvalId, 'denied', { by: 'whatsapp:test', channel: 'whatsapp' }));
    expect((await run(h2)).decisionsRecorded).toBe(1);

    const { rows } = await testDb().query<{ approval_id: string; verdict: string; wrong_reason: string | null; source_tiers: string[] }>(
      'SELECT approval_id, verdict, wrong_reason, source_tiers FROM contact_reply_decisions WHERE business_id = $1',
      [BUSINESS],
    );
    expect(rows).toHaveLength(2);
    const byApproval = new Map(rows.map((r) => [r.approval_id, r]));
    expect(byApproval.get(first.approvalId)?.verdict).toBe('right');
    expect(byApproval.get(second.approvalId)?.verdict).toBe('wrong');
    expect(byApproval.get(second.approvalId)?.wrong_reason).toBe('denied');
    expect(byApproval.get(first.approvalId)?.source_tiers).toEqual(['tier2', 'tier3']);
  });

  it('closes the conversation when the approval expired', async () => {
    const h = await harness();
    const card = await raise(h);
    await testDb().query(
      `UPDATE approval_requests SET state = 'expired' WHERE business_id = $1 AND approval_id = $2`,
      [BUSINESS, card.approvalId],
    );
    expect((await run(h)).expired).toBe(1);
    expect(await state(h)).toBe('expired');
  });

  it('closes the conversation when the card was denied', async () => {
    const h = await harness();
    const card = await raise(h);
    await withBusiness(BUSINESS, (db) => decide(db, card.approvalId, 'denied', { by: 'whatsapp:test', channel: 'whatsapp' }));
    await run(h);
    expect(await state(h)).toBe('closed');
  });

  it('a replaced card\'s cancelled approval does not close the conversation carded on the new job (R12a)', async () => {
    const h = await harness();
    await raise(h, 'ראשונה');
    const second = await raise(h, 'שנייה');
    await run(h);
    expect(await state(h)).toBe('carded');
    const conv = await withBusiness(BUSINESS, (db) => loadConversation(db, h.conversation.conversationId));
    expect(conv?.cardJobId).toBe(second.jobId);
  });

  it('an approved card whose job is in execute stays carded (R12b)', async () => {
    const h = await harness();
    const card = await raise(h);
    await withBusiness(BUSINESS, (db) => decide(db, card.approvalId, 'approved', { by: 'whatsapp:test', channel: 'whatsapp' }));
    await setPhase(card.jobId, 'execute');
    await run(h);
    expect(await state(h)).toBe('carded');
  });

  it('marks the conversation answered once the card job closed with a performed step', async () => {
    const h = await harness();
    const card = await raise(h);
    await withBusiness(BUSINESS, (db) => decide(db, card.approvalId, 'approved', { by: 'whatsapp:test', channel: 'whatsapp' }));
    await testDb().query(
      `UPDATE approval_requests SET consumed_at = now(), consumed_by_step = 'reply' WHERE business_id = $1 AND approval_id = $2`,
      [BUSINESS, card.approvalId],
    );
    await setPhase(card.jobId, 'closed');
    await testDb().query(
      `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, status, performed)
       VALUES ($1, $2, 'h', 'reply', 'completed', true)`,
      [BUSINESS, card.jobId],
    );
    expect((await run(h)).answered).toBe(1);
    expect(await state(h)).toBe('answered');
  });
});

describe('sourceTiersFromDetail', () => {
  it('reads tiers from the card text and gives [] for unknown senders', () => {
    expect(sourceTiersFromDetail('מי: x\nמה נמצא: הצעת מחיר 1\nלמה: y', 'client')).toEqual(['tier2']);
    expect(sourceTiersFromDetail('מה נמצא: מסמכים פנימיים', 'supplier')).toEqual(['tier3']);
    expect(sourceTiersFromDetail('מה נמצא: לא נמצא מידע רלוונטי', 'client')).toEqual([]);
    expect(sourceTiersFromDetail('מה נמצא: הצעת מחיר 1', 'unknown')).toEqual([]);
  });
});
