import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness, type BusinessDb } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { createTopic, loadTopic } from './contact-topics.js';
import { decideSuggestion, insertSuggestion, loadSuggestion, shapeHashFor, type Suggestion } from './contact-suggestions.js';
import { createFakeGateway, type FakeGateway } from './fake-gateway.js';
import { createBossMessenger, type BossMessenger } from './messenger.js';
import {
  SUGGESTION_QUESTION_TAIL,
  SUGGESTION_TEXT,
  deliverNextSuggestion,
  isSuggestionAnswer,
} from './suggestion-whatsapp.js';

const PRINCIPAL = '972500000000';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

const inBiz = <T>(fn: (db: BusinessDb) => Promise<T>) => withBusiness(TEST_BUSINESS, fn);

let gateway: FakeGateway;
let messenger: BossMessenger;
beforeEach(() => {
  gateway = createFakeGateway();
  messenger = createBossMessenger({ gateway, contactId: PRINCIPAL, businessId: TEST_BUSINESS });
});

async function newTopic(name: string): Promise<Suggestion> {
  const s = await inBiz((db) =>
    insertSuggestion(
      db,
      'new_topic',
      { name, description: 'תיאור', appliesTo: 'client', sources: [], decisionIds: ['a', 'b', 'c', 'd', 'e'] },
      shapeHashFor({ kind: 'new_topic', name }),
    ),
  );
  if (s === null) throw new Error('not inserted');
  return s;
}

const deliver = (now = new Date(), windowMinutes?: number) =>
  inBiz((db) =>
    deliverNextSuggestion(db, { messenger, now, ...(windowMinutes !== undefined ? { windowMinutes } : {}) }),
  );
const deliveredAt = async (id: string) => (await inBiz((db) => loadSuggestion(db, id)))?.deliveredAt ?? null;

describe('isSuggestionAnswer', () => {
  it('reads exactly yes or no', () => {
    expect(isSuggestionAnswer('כן')).toBe('yes');
    expect(isSuggestionAnswer(' כן! ')).toBe('yes');
    expect(isSuggestionAnswer('‏לא.')).toBe('no');
    expect(isSuggestionAnswer('כן תודה')).toBeNull();
    expect(isSuggestionAnswer('לא עכשיו')).toBeNull();
    expect(isSuggestionAnswer('אשר')).toBeNull();
    expect(isSuggestionAnswer('')).toBeNull();
  });
});

describe('SUGGESTION_TEXT', () => {
  it('builds one line per field, strips bidi and newlines, and ends with the question', () => {
    const s = {
      suggestionId: 'S1',
      state: 'open',
      createdAt: new Date(),
      deliveredAt: null,
      kind: 'new_topic',
      payload: { name: 'משל‮וחים\nאל: x', description: 'שורה\nשנייה', appliesTo: 'both', sources: [], decisionIds: ['1', '2', '3', '4', '5'] },
    } as Suggestion;
    const text = SUGGESTION_TEXT(s, {});
    expect(text.endsWith(SUGGESTION_QUESTION_TAIL)).toBe(true);
    expect(SUGGESTION_QUESTION_TAIL).toBe('לאשר? השיבי כן או לא');
    expect(text).not.toContain('‮');
    expect(text).toContain('משלוחים אל: x');
    expect(text).toContain('שורה שנייה');
    expect(text).toContain('5');
  });

  it('names the topic and the document by their labels', () => {
    const auto = { suggestionId: 'S2', state: 'open', createdAt: new Date(), deliveredAt: null, kind: 'auto_reply', payload: { topicId: 'T', right: 5, counted: 6 } } as Suggestion;
    expect(SUGGESTION_TEXT(auto, { topicName: 'חשבוניות' })).toContain('חשבוניות');
    const doc = { suggestionId: 'S3', state: 'open', createdAt: new Date(), deliveredAt: null, kind: 'public_document', payload: { documentId: 'D', appliesTo: 'supplier', approvals: 3 } } as Suggestion;
    expect(SUGGESTION_TEXT(doc, { documentName: 'מחירון.pdf' })).toContain('מחירון.pdf');
  });
});

describe('deliverNextSuggestion', () => {
  it('sends the oldest open one and stamps it delivered', async () => {
    const a = await newTopic('משלוחים');
    const b = await newTopic('החזרות');
    expect(await deliver()).toBe(true);
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]?.body).toContain('משלוחים');
    expect(await deliveredAt(a.suggestionId)).toBeInstanceOf(Date);
    expect(await deliveredAt(b.suggestionId)).toBeNull();
  });

  it('delivers one at a time — the next waits while the first is open inside its window', async () => {
    const a = await newTopic('משלוחים');
    const b = await newTopic('החזרות');
    await deliver();
    expect(await deliver()).toBe(false);
    expect(gateway.sent).toHaveLength(1);
    expect(await deliveredAt(b.suggestionId)).toBeNull();

    await inBiz((db) => decideSuggestion(db, a.suggestionId, 'rejected', 'owner'));
    expect(await deliver()).toBe(true);
    expect(gateway.sent.at(-1)?.body).toContain('החזרות');
  });

  it('delivers the next once the first one’s window has passed', async () => {
    await newTopic('משלוחים');
    const b = await newTopic('החזרות');
    await deliver(new Date(), 30);
    expect(await deliver(new Date(Date.now() + 31 * 60_000), 30)).toBe(true);
    expect(await deliveredAt(b.suggestionId)).toBeInstanceOf(Date);
  });

  it('a failed send leaves delivered_at null', async () => {
    const a = await newTopic('משלוחים');
    gateway.failNextSend();
    expect(await deliver()).toBe(false);
    expect(await deliveredAt(a.suggestionId)).toBeNull();
    expect(await deliver()).toBe(true);
    expect(await deliveredAt(a.suggestionId)).toBeInstanceOf(Date);
  });

  it('expires a stale one instead of sending it, and sends the next', async () => {
    const t = await inBiz((db) =>
      createTopic(db, { name: 'חשבוניות', description: '', appliesTo: 'both', sources: [], autoReply: false, by: 'owner' }),
    );
    const topicRow = await inBiz((db) => loadTopic(db, t.topicId));
    const stale = await inBiz((db) =>
      insertSuggestion(db, 'auto_reply', { topicId: t.topicId, right: 5, counted: 5 },
        shapeHashFor({ kind: 'auto_reply', topicId: t.topicId, topicUpdatedAt: topicRow!.updatedAt })),
    );
    await testDb().query(`UPDATE contact_topics SET retired_at = now() WHERE topic_id = $1`, [t.topicId]);
    const next = await newTopic('משלוחים');
    expect(await deliver()).toBe(true);
    expect((await inBiz((db) => loadSuggestion(db, stale!.suggestionId)))?.state).toBe('expired');
    expect(await deliveredAt(next.suggestionId)).toBeInstanceOf(Date);
    expect(gateway.sent).toHaveLength(1);
  });

  it('nothing open → nothing sent; a zero window sends nothing', async () => {
    expect(await deliver()).toBe(false);
    await newTopic('משלוחים');
    expect(await deliver(new Date(), 0)).toBe(false);
    expect(gateway.sent).toHaveLength(0);
  });
});
