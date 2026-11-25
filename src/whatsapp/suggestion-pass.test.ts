import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import type { ContactClusterer } from '../sdk/contact-clusterer.js';
import { createTopic, updateTopic } from './contact-topics.js';
import { decideSuggestion, listOpenSuggestions } from './contact-suggestions.js';
import { buildSuggestions } from './suggestion-pass.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

async function decision(over: { topicId?: string | null; docs?: string[] | null; summary?: string; at?: Date } = {}): Promise<void> {
  const conv = ulid();
  await testDb().query(
    `INSERT INTO contact_conversations (business_id, conversation_id, contact_key, contact_kind, state, last_inbound_at)
     VALUES ($1, $2, $2, 'client', 'answered', now())`,
    [TEST_BUSINESS, conv],
  );
  await testDb().query(
    `INSERT INTO contact_reply_decisions
       (business_id, decision_id, conversation_id, job_id, approval_id, verdict, wrong_reason, source_tiers,
        decided_at, topic_id, summary, source_names, internal_document_ids)
     VALUES ($1,$2,$3,$4,$5,'right',NULL,'{}',$6,$7,$8,'{}',$9)`,
    [TEST_BUSINESS, ulid(), conv, ulid(), ulid(), over.at ?? new Date(), over.topicId ?? null,
      over.summary ?? 'מתי המשלוח מגיע', over.docs ?? null],
  );
}

async function topic() {
  const t = await withBusiness(TEST_BUSINESS, (db) =>
    createTopic(db, { name: 'חשבוניות', description: '', appliesTo: 'both', sources: ['uploaded_invoices'], autoReply: false, by: 'owner' }),
  );
  await testDb().query(`UPDATE contact_topics SET updated_at = now() - interval '1 hour' WHERE topic_id = $1`, [t.topicId]);
  return t;
}

let calls = 0;
const group: ContactClusterer = async (req) => {
  calls++;
  return {
    status: 'ok',
    raw: { groups: [{ name: 'משלוחים', description: 'שאלות על משלוחים', indexes: req.summaries.map((s) => s.index) }] },
  };
};
const throwing: ContactClusterer = async () => {
  calls++;
  throw new Error('boom');
};
beforeEach(() => {
  calls = 0;
});

const run = (clusterer: ContactClusterer = group, clusterRunsPerDay = 2) =>
  withBusiness(TEST_BUSINESS, (db) =>
    buildSuggestions(db, { clusterer, now: new Date(), clusterRunsPerDay, charterVersion: 'v1' }),
  );
const open = () => withBusiness(TEST_BUSINESS, (db) => listOpenSuggestions(db));
const clusterAudits = async () =>
  Number(
    (await testDb().query(`SELECT count(*) AS n FROM audit_log WHERE business_id = $1 AND reason LIKE 'contact_cluster%'`, [TEST_BUSINESS]))
      .rows[0].n,
  );

describe('buildSuggestions: auto reply', () => {
  it('suggests a learned topic once, however many passes', async () => {
    const t = await topic();
    for (let i = 0; i < 5; i++) await decision({ topicId: t.topicId });
    expect((await run()).inserted).toBe(1);
    expect((await run()).inserted).toBe(0);
    const list = await open();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'auto_reply', payload: { topicId: t.topicId, right: 5, counted: 5 } });
  });

  it('does not re-suggest a rejected topic until the topic changes', async () => {
    const t = await topic();
    for (let i = 0; i < 5; i++) await decision({ topicId: t.topicId });
    await run();
    const s = (await open())[0]!;
    await withBusiness(TEST_BUSINESS, (db) => decideSuggestion(db, s.suggestionId, 'rejected', 'owner'));
    expect((await run()).inserted).toBe(0);
    expect(await open()).toHaveLength(0);

    await withBusiness(TEST_BUSINESS, (db) => updateTopic(db, t.topicId, { description: 'חדש' }, 'owner'));
    // updating a topic restarts its learning window; decisions after it count again
    for (let i = 0; i < 5; i++) await decision({ topicId: t.topicId, at: new Date(Date.now() + 1000) });
    expect((await run()).inserted).toBe(1);
    expect(await open()).toHaveLength(1);
  });
});

describe('buildSuggestions: public document', () => {
  it('suggests an owner document leaned on by 3 approved drafts', async () => {
    await testDb().query(
      `INSERT INTO documents (business_id, document_id, sha256, original_name, media_type, byte_size, source, status, stored_path)
       VALUES ($1, 'DOC-A', $2, 'a.pdf', 'text/plain', 10, 'instruction', 'extracted', 'x/a')`,
      [TEST_BUSINESS, 'DOC-A'.padEnd(64, '0')],
    );
    for (let i = 0; i < 3; i++) await decision({ docs: ['DOC-A'] });
    expect((await run()).inserted).toBe(1);
    expect((await run()).inserted).toBe(0);
    expect((await open())[0]).toMatchObject({ kind: 'public_document', payload: { documentId: 'DOC-A', approvals: 3 } });
  });
});

describe('buildSuggestions: new topic', () => {
  it('clusters five unthemed decisions once and inserts the group', async () => {
    for (let i = 0; i < 5; i++) await decision();
    const out = await run();
    expect(out).toEqual({ inserted: 1, clusterCalled: true });
    expect(calls).toBe(1);
    expect((await open())[0]).toMatchObject({ kind: 'new_topic', payload: { name: 'משלוחים' } });
    expect(await clusterAudits()).toBe(1);
  });

  it('does not call again without new decisions', async () => {
    for (let i = 0; i < 5; i++) await decision();
    await run();
    const out = await run();
    expect(out.clusterCalled).toBe(false);
    expect(calls).toBe(1);
  });

  it('does not call with fewer than five', async () => {
    for (let i = 0; i < 4; i++) await decision();
    expect((await run()).clusterCalled).toBe(false);
    expect(calls).toBe(0);
  });

  it('never calls when the cap is 0', async () => {
    for (let i = 0; i < 5; i++) await decision();
    expect((await run(group, 0)).clusterCalled).toBe(false);
    expect(calls).toBe(0);
    expect(await clusterAudits()).toBe(0);
  });

  it('does not call once today\'s cap is reached, even with new decisions', async () => {
    for (let i = 0; i < 5; i++) await decision();
    await run(group, 1);
    for (let i = 0; i < 5; i++) await decision({ at: new Date(Date.now() + 5000) });
    expect((await run(group, 1)).clusterCalled).toBe(false);
    expect(calls).toBe(1);
  });

  it('leaves the audit row when the clusterer throws', async () => {
    for (let i = 0; i < 5; i++) await decision();
    await expect(run(throwing)).rejects.toThrow('boom');
    expect(calls).toBe(1);
    expect(await clusterAudits()).toBe(1);
  });
});
