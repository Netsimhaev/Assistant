import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness, type BusinessDb } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { createTopic, listTopics, loadTopic, retireTopic, setTopicAutoReply } from './contact-topics.js';
import { insertSuggestion, loadSuggestion, shapeHashFor } from './contact-suggestions.js';
import { applySuggestion } from './suggestion-apply.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

const inBiz = <T>(fn: (db: BusinessDb) => Promise<T>) => withBusiness(TEST_BUSINESS, fn);

async function newTopicSuggestion(name = 'משלוחים') {
  const s = await inBiz((db) =>
    insertSuggestion(
      db,
      'new_topic',
      { name, description: 'שאלות על משלוחים', appliesTo: 'client', sources: ['uploaded_invoices'], decisionIds: ['d1', 'd2'] },
      shapeHashFor({ kind: 'new_topic', name }),
    ),
  );
  if (s === null) throw new Error('not inserted');
  return s;
}

async function topic(autoReply = false) {
  return inBiz((db) =>
    createTopic(db, { name: 'חשבוניות', description: '', appliesTo: 'both', sources: ['uploaded_invoices'], autoReply, by: 'owner' }),
  );
}

async function autoReplySuggestion(topicId: string) {
  const t = await inBiz((db) => loadTopic(db, topicId));
  const s = await inBiz((db) =>
    insertSuggestion(
      db,
      'auto_reply',
      { topicId, right: 5, counted: 5 },
      shapeHashFor({ kind: 'auto_reply', topicId, topicUpdatedAt: t!.updatedAt }),
    ),
  );
  if (s === null) throw new Error('not inserted');
  return s;
}

async function insertDocument(id: string, source = 'instruction', status = 'extracted'): Promise<void> {
  await testDb().query(
    `INSERT INTO documents (business_id, document_id, sha256, original_name, media_type, byte_size, source, status, stored_path)
     VALUES ($1, $2, $3, 'מחירון.pdf', 'text/plain', 10, $4, $5, 'x/a')`,
    [TEST_BUSINESS, id, id.padEnd(64, '0'), source, status],
  );
}

async function publicDocumentSuggestion(documentId: string) {
  const s = await inBiz((db) =>
    insertSuggestion(
      db,
      'public_document',
      { documentId, appliesTo: 'client', approvals: 3 },
      shapeHashFor({ kind: 'public_document', documentId }),
    ),
  );
  if (s === null) throw new Error('not inserted');
  return s;
}

async function publicFor(documentId: string): Promise<string | null> {
  const { rows } = await testDb().query<{ public_for: string | null }>(
    'SELECT public_for FROM documents WHERE business_id = $1 AND document_id = $2',
    [TEST_BUSINESS, documentId],
  );
  return rows[0]?.public_for ?? null;
}

async function auditReasons(): Promise<string[]> {
  const { rows } = await testDb().query<{ reason: string }>(
    `SELECT reason FROM audit_log WHERE business_id = $1 AND reason LIKE 'contact_suggestion:%' ORDER BY seq`,
    [TEST_BUSINESS],
  );
  return rows.map((r) => r.reason);
}

const stateOf = async (id: string) => (await inBiz((db) => loadSuggestion(db, id)))?.state;
const apply = (id: string, d: 'accept' | 'reject') => inBiz((db) => applySuggestion(db, id, d, 'whatsapp:972500000000'));

describe('applySuggestion: accept', () => {
  it('new topic: creates it with auto reply off, marks accepted, audits', async () => {
    const s = await newTopicSuggestion();
    expect(await apply(s.suggestionId, 'accept')).toBe('applied');
    const topics = await inBiz((db) => listTopics(db));
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({ name: 'משלוחים', appliesTo: 'client', autoReply: false, sources: ['uploaded_invoices'] });
    expect(await stateOf(s.suggestionId)).toBe('accepted');
    expect(await auditReasons()).toEqual(['contact_suggestion:new_topic:accepted']);
  });

  it('new topic: auto reply is off even when the stored payload says otherwise', async () => {
    const s = await newTopicSuggestion();
    await testDb().query(
      `UPDATE contact_suggestions SET payload = payload || '{"autoReply": true}'::jsonb WHERE suggestion_id = $1`,
      [s.suggestionId],
    );
    expect(await apply(s.suggestionId, 'accept')).toBe('applied');
    expect((await inBiz((db) => listTopics(db)))[0]?.autoReply).toBe(false);
  });

  it('auto reply: turns it on, marks accepted, audits', async () => {
    const t = await topic();
    const s = await autoReplySuggestion(t.topicId);
    expect(await apply(s.suggestionId, 'accept')).toBe('applied');
    expect((await inBiz((db) => loadTopic(db, t.topicId)))?.autoReply).toBe(true);
    expect(await stateOf(s.suggestionId)).toBe('accepted');
    expect(await auditReasons()).toEqual(['contact_suggestion:auto_reply:accepted']);
  });

  it('public document: sets public_for, marks accepted, audits', async () => {
    await insertDocument('DOC-A');
    const s = await publicDocumentSuggestion('DOC-A');
    expect(await apply(s.suggestionId, 'accept')).toBe('applied');
    expect(await publicFor('DOC-A')).toBe('client');
    expect(await stateOf(s.suggestionId)).toBe('accepted');
    expect(await auditReasons()).toEqual(['contact_suggestion:public_document:accepted']);
  });

  it('a second accept is already, and changes nothing more', async () => {
    const s = await newTopicSuggestion();
    expect(await apply(s.suggestionId, 'accept')).toBe('applied');
    expect(await apply(s.suggestionId, 'accept')).toBe('already');
    expect(await apply(s.suggestionId, 'reject')).toBe('already');
    expect(await inBiz((db) => listTopics(db))).toHaveLength(1);
    expect(await stateOf(s.suggestionId)).toBe('accepted');
  });

  it('a failing effect rolls the claim back — the suggestion stays open', async () => {
    const s = await newTopicSuggestion();
    // An applies-to value createTopic refuses: the effect throws after the claim.
    await testDb().query(
      `UPDATE contact_suggestions SET payload = jsonb_set(payload, '{appliesTo}', '"nobody"') WHERE suggestion_id = $1`,
      [s.suggestionId],
    );
    await expect(apply(s.suggestionId, 'accept')).rejects.toThrow();
    expect(await stateOf(s.suggestionId)).toBe('open');
    expect(await inBiz((db) => listTopics(db))).toHaveLength(0);
    expect(await auditReasons()).toEqual([]);
  });
});

describe('applySuggestion: reject', () => {
  it('changes nothing and marks rejected', async () => {
    const t = await topic();
    const s = await autoReplySuggestion(t.topicId);
    expect(await apply(s.suggestionId, 'reject')).toBe('rejected');
    expect((await inBiz((db) => loadTopic(db, t.topicId)))?.autoReply).toBe(false);
    expect(await stateOf(s.suggestionId)).toBe('rejected');
    expect(await auditReasons()).toEqual(['contact_suggestion:auto_reply:rejected']);
  });
});

describe('applySuggestion: stale accept', () => {
  it('auto reply on a retired topic → stale, nothing changes', async () => {
    const t = await topic();
    const s = await autoReplySuggestion(t.topicId);
    await inBiz((db) => retireTopic(db, t.topicId, 'owner'));
    expect(await apply(s.suggestionId, 'accept')).toBe('stale');
    expect((await inBiz((db) => loadTopic(db, t.topicId)))?.autoReply).toBe(false);
    expect(await stateOf(s.suggestionId)).toBe('expired');
    expect(await auditReasons()).toEqual(['contact_suggestion:auto_reply:expired']);
  });

  it('auto reply on a topic already answering alone → stale', async () => {
    const t = await topic();
    const s = await autoReplySuggestion(t.topicId);
    await inBiz((db) => setTopicAutoReply(db, t.topicId, true, 'owner'));
    expect(await apply(s.suggestionId, 'accept')).toBe('stale');
    expect(await stateOf(s.suggestionId)).toBe('expired');
  });

  it('public document re-sourced to mail → stale, public_for untouched', async () => {
    await insertDocument('DOC-A');
    const s = await publicDocumentSuggestion('DOC-A');
    await testDb().query(`UPDATE documents SET source = 'mail' WHERE document_id = 'DOC-A'`);
    expect(await apply(s.suggestionId, 'accept')).toBe('stale');
    expect(await publicFor('DOC-A')).toBeNull();
    expect(await stateOf(s.suggestionId)).toBe('expired');
  });

  it('public document removed or already public → stale', async () => {
    await insertDocument('DOC-A');
    await insertDocument('DOC-B');
    const a = await publicDocumentSuggestion('DOC-A');
    const b = await publicDocumentSuggestion('DOC-B');
    await testDb().query(`DELETE FROM documents WHERE document_id = 'DOC-A'`);
    await testDb().query(`UPDATE documents SET public_for = 'both' WHERE document_id = 'DOC-B'`);
    expect(await apply(a.suggestionId, 'accept')).toBe('stale');
    expect(await apply(b.suggestionId, 'accept')).toBe('stale');
    expect(await publicFor('DOC-B')).toBe('both');
  });

  it('new topic whose name is already a live topic → stale, no second topic', async () => {
    const s = await newTopicSuggestion('משלוחים');
    await inBiz((db) =>
      createTopic(db, { name: ' משלוחים ', description: '', appliesTo: 'both', sources: [], autoReply: false, by: 'owner' }),
    );
    expect(await apply(s.suggestionId, 'accept')).toBe('stale');
    expect(await inBiz((db) => listTopics(db))).toHaveLength(1);
    expect(await stateOf(s.suggestionId)).toBe('expired');
  });

  it('an unknown suggestion id is stale and writes nothing', async () => {
    expect(await apply('NOPE', 'accept')).toBe('stale');
    expect(await auditReasons()).toEqual([]);
  });
});
