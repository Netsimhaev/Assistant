import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { decide } from '../governance/approvals.js';
import { resetDatabase, testDb } from '../test/db.js';
import { installMailboxCharter } from '../test/mailbox.js';
import type { PolicyBundle } from '../domain/policy.js';
import { transition } from '../orchestrator/jobs.js';
import { raiseContactCard } from './contact-card.js';
import { loadCardContext } from './card-context.js';
import { createTopic } from './contact-topics.js';
import { loadConversation, openOrAppend, type ContactConversation } from './contact-conversations.js';
import { createFakeGateway, type FakeGateway } from './fake-gateway.js';
import { createBossMessenger, type BossMessenger } from './messenger.js';
import { AUTO_FAILED_REASON, MAY_HAVE_SENT_NOTE, reraiseFailedAutoReplies } from './contact-auto-reraise.js';

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
  topicId: string;
}

async function harness(): Promise<Harness> {
  const bundle = await installMailboxCharter(BUSINESS);
  const gateway = createFakeGateway();
  const messenger = createBossMessenger({ gateway, contactId: PRINCIPAL.slice(1), businessId: BUSINESS });
  const { conversation } = await withBusiness(BUSINESS, (db) =>
    openOrAppend(db, { key: KEY, subjectKey: null, kind: 'client', inboundAt: new Date() }),
  );
  const topic = await withBusiness(BUSINESS, (db) =>
    createTopic(db, {
      name: 'חשבוניות', description: 'מתי נשלחה חשבונית', appliesTo: 'client', sources: ['ledger_of_sender'], autoReply: true, by: 'owner',
    }),
  );
  return { bundle, gateway, messenger, conversation, topicId: topic.topicId };
}

const CONTEXT = (topicId: string) => ({
  kind: 'question' as const,
  topicId,
  summary: 'מתי נשלחה החשבונית',
  sourceNames: ['חשבוניות שהעלית'],
  internalDocumentIds: [],
});

function raiseAuto(h: Harness) {
  return withBusiness(BUSINESS, (db) =>
    raiseContactCard(db, {
      conversation: h.conversation,
      draft: { body: 'החשבונית נשלחה ב-3 לחודש.', attachDocumentId: null },
      reasonHe: 'x',
      sourcesHe: ['חשבוניות שהעלית'],
      bundle: h.bundle,
      contactLabel: 'דנה לוי',
      mode: 'auto',
      context: CONTEXT(h.topicId),
    }),
  );
}

async function failJob(jobId: string, code: string): Promise<void> {
  await withBusiness(BUSINESS, (db) =>
    transition(db, jobId, { to: 'failed', actor: 'orchestrator', reason: `${code} — the far end refused`, expectFrom: 'execute' }),
  );
}

function reraise(h: Harness) {
  return withBusiness(BUSINESS, (db) =>
    reraiseFailedAutoReplies(db, { bundle: h.bundle, gateway: h.gateway, messenger: h.messenger, now: new Date() }),
  );
}

const conv = (h: Harness) => withBusiness(BUSINESS, (db) => loadConversation(db, h.conversation.conversationId));

async function approvals(): Promise<{ job_id: string; detail: string; state: string }[]> {
  const { rows } = await testDb().query<{ job_id: string; detail: string; state: string }>(
    'SELECT job_id, detail, state FROM approval_requests WHERE business_id = $1 ORDER BY created_at',
    [BUSINESS],
  );
  return rows;
}

describe('a failed auto reply becomes a card, once', () => {
  it('raises one card for the failed auto job and points the conversation at it', async () => {
    const h = await harness();
    const auto = await raiseAuto(h);
    await failJob(auto.jobId, 'whatsapp_rejected');

    expect(await reraise(h)).toEqual({ reraised: 1, skipped: 0 });

    const rows = await approvals();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.job_id).not.toBe(auto.jobId);
    expect(rows[0]?.detail).toContain(AUTO_FAILED_REASON);
    expect(rows[0]?.detail).not.toContain(MAY_HAVE_SENT_NOTE);
    expect(rows[0]?.detail).toContain('החשבונית נשלחה ב-3 לחודש.');
    const c = await conv(h);
    expect(c?.state).toBe('carded');
    expect(c?.cardJobId).toBe(rows[0]?.job_id);
    // The owner got the card (with the proposed text and the instruction)...
    expect(h.gateway.sent.some((m) => m.body.includes('שלח') && m.body.includes('החשבונית נשלחה ב-3 לחודש.'))).toBe(true);
    // ...and the contact the holding reply, under the existing rules: sent now,
    // or deferred to the end of quiet hours (the clock is the real one).
    expect(c?.holdingSentAt !== null || c?.holdingDueAt !== null).toBe(true);
    // The new card keeps the context (topic, summary) as a non-auto card.
    const ctx = await withBusiness(BUSINESS, (db) => loadCardContext(db, rows[0]!.job_id));
    expect(ctx).toMatchObject({ topicId: h.topicId, summary: 'מתי נשלחה החשבונית', auto: false });
  });

  it('does nothing on a second pass', async () => {
    const h = await harness();
    const auto = await raiseAuto(h);
    await failJob(auto.jobId, 'whatsapp_rejected');
    await reraise(h);
    const sentBefore = h.gateway.sent.length;
    expect(await reraise(h)).toEqual({ reraised: 0, skipped: 0 });
    expect(await approvals()).toHaveLength(1);
    expect(h.gateway.sent.length).toBe(sentBefore);
  });

  it('says the message may already have gone out after an adapter_timeout unknown row', async () => {
    const h = await harness();
    const auto = await raiseAuto(h);
    await testDb().query(
      `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, status, performed)
       VALUES ($1, $2, 'h', 'reply', 'unknown', NULL)`,
      [BUSINESS, auto.jobId],
    );
    await failJob(auto.jobId, 'adapter_timeout');
    await reraise(h);
    const rows = await approvals();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain('ייתכן שההודעה כבר יצאה');
    expect(MAY_HAVE_SENT_NOTE).toContain('ייתכן שההודעה כבר יצאה');
  });

  it('says it too when only the failure code says so', async () => {
    const h = await harness();
    const auto = await raiseAuto(h);
    await failJob(auto.jobId, 'delivery_unknown');
    await reraise(h);
    expect((await approvals())[0]?.detail).toContain('ייתכן שההודעה כבר יצאה');
  });

  it('leaves a failed CARD job (it has an approval) alone', async () => {
    const h = await harness();
    const card = await withBusiness(BUSINESS, (db) =>
      raiseContactCard(db, {
        conversation: h.conversation,
        draft: { body: 'שלום', attachDocumentId: null },
        reasonHe: 'x', sourcesHe: [], bundle: h.bundle, contactLabel: 'דנה',
      }),
    );
    await withBusiness(BUSINESS, (db) => decide(db, card.approvalId, 'approved', { by: 'whatsapp:test', channel: 'whatsapp' }));
    await testDb().query(
      `INSERT INTO job_steps (business_id, job_id, from_phase, to_phase, actor, reason) VALUES ($1, $2, 'await_approval', 'failed', 'orchestrator', 'x')`,
      [BUSINESS, card.jobId],
    );
    await testDb().query(`UPDATE jobs SET phase = 'failed' WHERE business_id = $1 AND job_id = $2`, [BUSINESS, card.jobId]);
    expect(await reraise(h)).toEqual({ reraised: 0, skipped: 0 });
    expect((await conv(h))?.cardJobId).toBe(card.jobId);
    expect(await approvals()).toHaveLength(1);
  });

  it('does not re-raise when the conversation already moved on to a newer card', async () => {
    const h = await harness();
    const auto = await raiseAuto(h);
    await failJob(auto.jobId, 'whatsapp_rejected');
    const newer = await withBusiness(BUSINESS, (db) =>
      raiseContactCard(db, {
        conversation: h.conversation, draft: { body: 'חדש', attachDocumentId: null },
        reasonHe: 'x', sourcesHe: [], bundle: h.bundle, contactLabel: 'דנה',
      }),
    );
    expect(await reraise(h)).toEqual({ reraised: 0, skipped: 0 });
    expect((await conv(h))?.cardJobId).toBe(newer.jobId);
    expect(await approvals()).toHaveLength(1);
  });
});

/**
 * A trigger that makes every job_steps INSERT into one of `phases` fail, so a
 * transition throws after the conversation take-over. Dropped in `finally`:
 * TRUNCATE does not remove it.
 */
async function withFailingTransitions(phases: string[], fn: () => Promise<void>): Promise<void> {
  const list = phases.map((p) => `'${p}'`).join(',');
  await testDb().query(
    `CREATE OR REPLACE FUNCTION test_fail_transition() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.to_phase IN (${list}) THEN RAISE EXCEPTION 'forced transition failure'; END IF;
       RETURN NEW;
     END $$`,
  );
  await testDb().query(
    'CREATE TRIGGER test_fail_transition BEFORE INSERT ON job_steps FOR EACH ROW EXECUTE FUNCTION test_fail_transition()',
  );
  try {
    await fn();
  } finally {
    await testDb().query('DROP TRIGGER IF EXISTS test_fail_transition ON job_steps');
    await testDb().query('DROP FUNCTION IF EXISTS test_fail_transition()');
  }
}

async function autoJobId(): Promise<string> {
  const { rows } = await testDb().query<{ job_id: string }>(
    'SELECT job_id FROM contact_card_context WHERE business_id = $1 AND auto = true',
    [BUSINESS],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.job_id;
}

async function phaseOf(jobId: string): Promise<string> {
  const { rows } = await testDb().query<{ phase: string }>('SELECT phase FROM jobs WHERE business_id = $1 AND job_id = $2', [BUSINESS, jobId]);
  return rows[0]!.phase;
}

describe('an auto job stranded after the take-over (final review I1)', () => {
  it('re-raises an auto job whose plan -> execute threw after the conversation was taken over', async () => {
    const h = await harness();
    await withFailingTransitions(['execute'], async () => {
      await expect(raiseAuto(h)).rejects.toThrow();
    });
    const jobId = await autoJobId();
    // The take-over happened: the conversation is carded on the failed job,
    // which never reached execute.
    expect(await phaseOf(jobId)).toBe('failed');
    expect((await conv(h))?.cardJobId).toBe(jobId);

    expect(await reraise(h)).toEqual({ reraised: 1, skipped: 0 });
    const rows = await approvals();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain(AUTO_FAILED_REASON);
    expect((await conv(h))?.cardJobId).toBe(rows[0]?.job_id);
  });

  it('fails and re-raises an auto job left in plan for more than 15 minutes', async () => {
    const h = await harness();
    await withFailingTransitions(['execute', 'failed'], async () => {
      await expect(raiseAuto(h)).rejects.toThrow();
    });
    const jobId = await autoJobId();
    expect(await phaseOf(jobId)).toBe('plan');
    await testDb().query(
      `UPDATE jobs SET updated_at = now() - interval '16 minutes' WHERE business_id = $1 AND job_id = $2`,
      [BUSINESS, jobId],
    );

    expect(await reraise(h)).toEqual({ reraised: 1, skipped: 0 });
    expect(await phaseOf(jobId)).toBe('failed');
    const rows = await approvals();
    expect(rows).toHaveLength(1);
    expect((await conv(h))?.cardJobId).toBe(rows[0]?.job_id);
  });

  it('leaves an auto job in plan for 5 minutes untouched', async () => {
    const h = await harness();
    await withFailingTransitions(['execute', 'failed'], async () => {
      await expect(raiseAuto(h)).rejects.toThrow();
    });
    const jobId = await autoJobId();
    await testDb().query(
      `UPDATE jobs SET updated_at = now() - interval '5 minutes' WHERE business_id = $1 AND job_id = $2`,
      [BUSINESS, jobId],
    );

    expect(await reraise(h)).toEqual({ reraised: 0, skipped: 0 });
    expect(await phaseOf(jobId)).toBe('plan');
    expect(await approvals()).toHaveLength(0);
    expect((await conv(h))?.cardJobId).toBe(jobId);
  });
});
