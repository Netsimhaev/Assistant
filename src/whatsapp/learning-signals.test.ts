import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { createTopic, retireTopic, type ContactTopic } from './contact-topics.js';
import {
  PUBLIC_DOC_MIN_APPROVALS,
  autoReplyCandidates,
  publicDocumentCandidates,
  unthemedDecisions,
} from './learning-signals.js';

const BUSINESS = 'test-business';
const OTHER = 'other-business';
const DAY = 86_400_000;

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

async function conversation(business: string, kind: string): Promise<string> {
  const id = ulid();
  await testDb().query(
    `INSERT INTO contact_conversations (business_id, conversation_id, contact_key, contact_kind, state, last_inbound_at)
     VALUES ($1, $2, $3, $4, 'answered', now())`,
    [business, id, id, kind],
  );
  return id;
}

interface Dec {
  business?: string;
  verdict?: string | null;
  wrongReason?: string | null;
  topicId?: string | null;
  summary?: string | null;
  docs?: string[] | null;
  kind?: string;
  at?: Date;
  sources?: string[];
  job?: string;
}
async function decision(d: Dec = {}): Promise<string> {
  const business = d.business ?? BUSINESS;
  const conv = await conversation(business, d.kind ?? 'client');
  const id = ulid();
  await testDb().query(
    `INSERT INTO contact_reply_decisions
       (business_id, decision_id, conversation_id, job_id, approval_id, verdict, wrong_reason, source_tiers,
        decided_at, topic_id, summary, source_names, internal_document_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'{}',$8,$9,$10,$11,$12)`,
    [
      business, id, conv, d.job ?? ulid(), ulid(), d.verdict === undefined ? 'right' : d.verdict, d.wrongReason ?? null,
      d.at ?? new Date(), d.topicId ?? null, d.summary === undefined ? 'שאלה' : d.summary,
      d.sources ?? ['יומן'], d.docs === undefined ? null : d.docs,
    ],
  );
  return id;
}

const topic = (autoReply = false): Promise<ContactTopic> =>
  withBusiness(BUSINESS, (db) =>
    createTopic(db, { name: 'חשבוניות', description: '', appliesTo: 'both', sources: ['uploaded_invoices'], autoReply, by: 'owner' }),
  );

const candidates = () => withBusiness(BUSINESS, (db) => autoReplyCandidates(db, new Date()));

describe('autoReplyCandidates', () => {
  it('returns a topic with 5 right decisions in the window', async () => {
    const t = await topic();
    for (let i = 0; i < 5; i++) await decision({ topicId: t.topicId });
    const out = await candidates();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ right: 5, counted: 5 });
    expect(out[0]?.topic.topicId).toBe(t.topicId);
  });

  it('counts the earliest decision per job only', async () => {
    const t = await topic();
    for (let i = 0; i < 5; i++) await decision({ topicId: t.topicId, job: `J${i}`, at: new Date(Date.now() - 2000) });
    await decision({ topicId: t.topicId, job: 'J0', verdict: 'wrong', wrongReason: 'edited', at: new Date(Date.now() - 1000) });
    const out = await candidates();
    expect(out[0]).toMatchObject({ right: 5, counted: 5 });
  });

  it('ignores a topic with only 4 decisions', async () => {
    const t = await topic();
    for (let i = 0; i < 4; i++) await decision({ topicId: t.topicId });
    expect(await candidates()).toEqual([]);
  });

  it('accepts 5 right + 1 wrong (83%)', async () => {
    const t = await topic();
    for (let i = 0; i < 5; i++) await decision({ topicId: t.topicId });
    await decision({ topicId: t.topicId, verdict: 'wrong', wrongReason: 'edited' });
    const out = await candidates();
    expect(out[0]).toMatchObject({ right: 5, counted: 6 });
  });

  it('rejects 4 right + 1 wrong (80% is not above 80%)', async () => {
    const t = await topic();
    for (let i = 0; i < 4; i++) await decision({ topicId: t.topicId });
    await decision({ topicId: t.topicId, verdict: 'wrong', wrongReason: 'edited' });
    expect(await candidates()).toEqual([]);
  });

  it('does not count not_counted decisions', async () => {
    const t = await topic();
    for (let i = 0; i < 4; i++) await decision({ topicId: t.topicId });
    await decision({ topicId: t.topicId, verdict: 'not_counted' });
    expect(await candidates()).toEqual([]);
  });

  it('does not count decisions older than the topic updatedAt', async () => {
    const t = await topic();
    for (let i = 0; i < 5; i++) await decision({ topicId: t.topicId, at: new Date(Date.now() - 2 * 3_600_000) });
    await testDb().query(`UPDATE contact_topics SET updated_at = now() - interval '1 hour' WHERE topic_id = $1`, [t.topicId]);
    expect(await candidates()).toEqual([]);
  });

  it('does not count decisions older than the agreement window', async () => {
    const t = await topic();
    await testDb().query(`UPDATE contact_topics SET updated_at = now() - interval '60 days' WHERE topic_id = $1`, [t.topicId]);
    for (let i = 0; i < 5; i++) await decision({ topicId: t.topicId, at: new Date(Date.now() - 20 * DAY) });
    expect(await candidates()).toEqual([]);
  });

  it('never returns a topic that already auto-replies', async () => {
    const t = await topic(true);
    for (let i = 0; i < 5; i++) await decision({ topicId: t.topicId });
    expect(await candidates()).toEqual([]);
  });

  it('never returns a retired topic', async () => {
    const t = await topic();
    for (let i = 0; i < 5; i++) await decision({ topicId: t.topicId });
    await withBusiness(BUSINESS, (db) => retireTopic(db, t.topicId, 'owner'));
    expect(await candidates()).toEqual([]);
  });
});

async function doc(id: string, source: string, business = BUSINESS): Promise<void> {
  await testDb().query(
    `INSERT INTO documents (business_id, document_id, sha256, original_name, media_type, byte_size, source, status, stored_path)
     VALUES ($1, $2, $3, $4, 'text/plain', 10, $5, 'extracted', $6)`,
    [business, id, id.padEnd(64, '0'), `${id}.pdf`, source, `x/${id}`],
  );
}
const publicCandidates = () => withBusiness(BUSINESS, (db) => publicDocumentCandidates(db));

describe('publicDocumentCandidates', () => {
  it('has the threshold of three', () => {
    expect(PUBLIC_DOC_MIN_APPROVALS).toBe(3);
  });

  it('suggests an owner document on 3 approved decisions, appliesTo from the kinds', async () => {
    await doc('DOC-A', 'instruction');
    await decision({ docs: ['DOC-A'], kind: 'client' });
    await decision({ docs: ['DOC-A'], kind: 'client' });
    await decision({ docs: ['DOC-A'], kind: 'unknown' });
    expect(await publicCandidates()).toEqual([{ documentId: 'DOC-A', approvals: 3, appliesTo: 'client' }]);
  });

  it('is both when clients and suppliers mix', async () => {
    await doc('DOC-A', 'instruction');
    await decision({ docs: ['DOC-A'], kind: 'client' });
    await decision({ docs: ['DOC-A'], kind: 'supplier' });
    await decision({ docs: ['DOC-A'], kind: 'supplier' });
    expect((await publicCandidates())[0]?.appliesTo).toBe('both');
  });

  it('is supplier when all are suppliers', async () => {
    await doc('DOC-A', 'instruction');
    for (let i = 0; i < 3; i++) await decision({ docs: ['DOC-A'], kind: 'supplier' });
    expect((await publicCandidates())[0]?.appliesTo).toBe('supplier');
  });

  it('counts an edited approval (wrong, not denied)', async () => {
    await doc('DOC-A', 'instruction');
    await decision({ docs: ['DOC-A'] });
    await decision({ docs: ['DOC-A'] });
    await decision({ docs: ['DOC-A'], verdict: 'wrong', wrongReason: 'edited' });
    expect((await publicCandidates())[0]?.approvals).toBe(3);
  });

  it('does not count a denied decision', async () => {
    await doc('DOC-A', 'instruction');
    await decision({ docs: ['DOC-A'] });
    await decision({ docs: ['DOC-A'] });
    await decision({ docs: ['DOC-A'], verdict: 'wrong', wrongReason: 'denied' });
    expect(await publicCandidates()).toEqual([]);
  });

  it('does not suggest with only 2 approvals', async () => {
    await doc('DOC-A', 'instruction');
    await decision({ docs: ['DOC-A'] });
    await decision({ docs: ['DOC-A'] });
    expect(await publicCandidates()).toEqual([]);
  });

  it('never suggests a foreign (mail) document', async () => {
    await doc('DOC-M', 'mail');
    for (let i = 0; i < 3; i++) await decision({ docs: ['DOC-M'] });
    expect(await publicCandidates()).toEqual([]);
  });

  it('skips a document that is already public', async () => {
    await doc('DOC-A', 'instruction');
    await testDb().query(`UPDATE documents SET public_for = 'both' WHERE document_id = 'DOC-A'`);
    for (let i = 0; i < 3; i++) await decision({ docs: ['DOC-A'] });
    expect(await publicCandidates()).toEqual([]);
  });

  it('skips when only unknown kinds remain', async () => {
    await doc('DOC-A', 'instruction');
    for (let i = 0; i < 3; i++) await decision({ docs: ['DOC-A'], kind: 'unknown' });
    expect(await publicCandidates()).toEqual([]);
  });

  it('counts one approval per job, not per decision', async () => {
    await doc('DOC-A', 'instruction');
    await decision({ docs: ['DOC-A'], job: 'J1' });
    await decision({ docs: ['DOC-A'], job: 'J1' });
    await decision({ docs: ['DOC-A'], job: 'J2' });
    expect(await publicCandidates()).toEqual([]);
  });

  it('counts a document listed twice in one decision once', async () => {
    await doc('DOC-A', 'instruction');
    await decision({ docs: ['DOC-A', 'DOC-A'] });
    await decision({ docs: ['DOC-A'] });
    expect(await publicCandidates()).toEqual([]);
  });

  it('ignores another business', async () => {
    await doc('DOC-A', 'instruction', OTHER);
    for (let i = 0; i < 3; i++) await decision({ docs: ['DOC-A'], business: OTHER });
    expect(await publicCandidates()).toEqual([]);
  });
});

describe('unthemedDecisions', () => {
  const run = (limit?: number) => withBusiness(BUSINESS, (db) => unthemedDecisions(db, new Date(), limit));

  it('returns unthemed decisions with summary, newest first, with kind and approval', async () => {
    const older = await decision({ summary: 'ישן', at: new Date(Date.now() - 2 * DAY), kind: 'supplier', sources: ['a'] });
    const newer = await decision({ summary: 'חדש', verdict: 'wrong', wrongReason: 'denied' });
    const out = await run();
    expect(out.map((d) => d.decisionId)).toEqual([newer, older]);
    expect(out[0]).toMatchObject({ summary: 'חדש', approved: false, contactKind: 'client' });
    expect(out[1]).toMatchObject({ approved: true, contactKind: 'supplier', sourceNames: ['a'] });
  });

  it('excludes phase-1 rows (no summary), themed rows, old rows and other businesses', async () => {
    const t = await topic();
    await decision({ summary: null });
    await decision({ topicId: t.topicId });
    await decision({ at: new Date(Date.now() - 31 * DAY) });
    await decision({ business: OTHER });
    const keep = await decision();
    expect((await run()).map((d) => d.decisionId)).toEqual([keep]);
  });

  it('returns one row per job (the earliest)', async () => {
    const first = await decision({ job: 'J1', at: new Date(Date.now() - 2000) });
    await decision({ job: 'J1', at: new Date(Date.now() - 1000) });
    expect((await run()).map((d) => d.decisionId)).toEqual([first]);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 3; i++) await decision();
    expect(await run(2)).toHaveLength(2);
  });
});
