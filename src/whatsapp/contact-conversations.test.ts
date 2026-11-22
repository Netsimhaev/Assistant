import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import {
  closeConversation,
  conversationByCardJob,
  loadConversation,
  openOrAppend,
  recentMessages,
  setCard,
} from './contact-conversations.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

const KEY = '972501110001';
const at = (m: number) => new Date(Date.UTC(2026, 10, 21, 10, m));
const input = (m: number) => ({ key: KEY, subjectKey: null, kind: 'client' as const, inboundAt: at(m) });

async function seed(id: string, dir: 'inbound' | 'outbound', num: string, body: string, m: number) {
  const col = dir === 'inbound' ? 'sender_number' : 'recipient_number';
  await testDb().query(
    `INSERT INTO whatsapp_messages (id, business_id, direction, ${col}, body, provider_timestamp, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'handled')`,
    [id, TEST_BUSINESS, dir, num, body, at(m)],
  );
}

describe('contact conversations', () => {
  it('two messages from one number share one live conversation', async () => {
    const a = await withBusiness(TEST_BUSINESS, (db) => openOrAppend(db, input(0)));
    const b = await withBusiness(TEST_BUSINESS, (db) => openOrAppend(db, input(5)));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.conversation.conversationId).toBe(a.conversation.conversationId);
    expect(b.conversation.lastInboundAt).toEqual(at(5));
  });

  it('concurrent openOrAppend creates one row', async () => {
    const rs = await Promise.all([
      withBusiness(TEST_BUSINESS, (db) => openOrAppend(db, input(0))),
      withBusiness(TEST_BUSINESS, (db) => openOrAppend(db, input(1))),
    ]);
    expect(rs[0].conversation.conversationId).toBe(rs[1].conversation.conversationId);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    const { rows } = await testDb().query('SELECT 1 FROM contact_conversations');
    expect(rows).toHaveLength(1);
  });

  it('a closed conversation is not reused', async () => {
    const a = await withBusiness(TEST_BUSINESS, (db) => openOrAppend(db, input(0)));
    await withBusiness(TEST_BUSINESS, (db) => closeConversation(db, a.conversation.conversationId, 'answered'));
    const b = await withBusiness(TEST_BUSINESS, (db) => openOrAppend(db, input(9)));
    expect(b.created).toBe(true);
    expect(b.conversation.conversationId).not.toBe(a.conversation.conversationId);
    const old = await withBusiness(TEST_BUSINESS, (db) => loadConversation(db, a.conversation.conversationId));
    expect(old?.state).toBe('answered');
    expect(old?.closedAt).not.toBeNull();
  });

  it('setCard marks carded and is found by its job', async () => {
    const a = await withBusiness(TEST_BUSINESS, (db) => openOrAppend(db, input(0)));
    await withBusiness(TEST_BUSINESS, (db) => setCard(db, a.conversation.conversationId, 'job-1', at(2), null));
    const c = await withBusiness(TEST_BUSINESS, (db) => conversationByCardJob(db, 'job-1'));
    expect(c).toMatchObject({ state: 'carded', cardJobId: 'job-1', cardPresentedAt: at(2) });
    const b = await withBusiness(TEST_BUSINESS, (db) => openOrAppend(db, input(3)));
    expect(b.created).toBe(false);
  });

  it('setCard is a compare-and-swap on the previous card job (R11b)', async () => {
    const a = await withBusiness(TEST_BUSINESS, (db) => openOrAppend(db, input(0)));
    const id = a.conversation.conversationId;
    expect(await withBusiness(TEST_BUSINESS, (db) => setCard(db, id, 'job-1', null, null))).toBe(true);
    // A stale expectation (null, but job-1 is there now) loses and changes nothing.
    expect(await withBusiness(TEST_BUSINESS, (db) => setCard(db, id, 'job-2', null, null))).toBe(false);
    expect((await withBusiness(TEST_BUSINESS, (db) => loadConversation(db, id)))?.cardJobId).toBe('job-1');
    expect(await withBusiness(TEST_BUSINESS, (db) => setCard(db, id, 'job-2', null, 'job-1'))).toBe(true);
    expect((await withBusiness(TEST_BUSINESS, (db) => loadConversation(db, id)))?.cardJobId).toBe('job-2');
  });

  it('recentMessages returns both directions, newest 10, oldest first', async () => {
    for (let i = 0; i < 8; i++) await seed(`in-${i}`, 'inbound', i % 2 ? '+972 50-111-0001' : '972501110001', `in ${i}`, i * 2);
    for (let i = 0; i < 5; i++) await seed(`out-${i}`, 'outbound', '+972501110001', `out ${i}`, i * 2 + 1);
    await seed('other', 'inbound', '+972509999999', 'not mine', 3);
    const msgs = await withBusiness(TEST_BUSINESS, (db) => recentMessages(db, KEY));
    expect(msgs).toHaveLength(10);
    expect(msgs.map((m) => m.body)).not.toContain('not mine');
    expect(msgs.map((m) => m.at.getTime())).toEqual([...msgs.map((m) => m.at.getTime())].sort((x, y) => x - y));
    expect(msgs[0]?.body).toBe('out 1'); // 13 match; the oldest three (in 0, out 0, in 1) drop
    expect(new Set(msgs.map((m) => m.direction))).toEqual(new Set(['inbound', 'outbound']));
  });
});
