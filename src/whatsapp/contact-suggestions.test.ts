import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import {
  decideSuggestion,
  deliveredOpenSuggestions,
  insertSuggestion,
  listOpenSuggestions,
  loadSuggestion,
  markSuggestionDelivered,
  shapeHashFor,
} from './contact-suggestions.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

const topicPayload = { name: 'משלוחים', description: 'd', appliesTo: 'both' as const, sources: ['public' as const], decisionIds: ['a'] };
const topicShape = () => shapeHashFor({ kind: 'new_topic', name: 'משלוחים' });
const w = <T>(fn: Parameters<typeof withBusiness<T>>[1]) => withBusiness(TEST_BUSINESS, fn);
const setDeliveredAt = (id: string, at: Date) =>
  testDb().query(`UPDATE contact_suggestions SET delivered_at = $2 WHERE suggestion_id = $1`, [id, at]);

describe('contact suggestions store', () => {
  it('round-trips each kind', async () => {
    const a = await w((db) => insertSuggestion(db, 'new_topic', topicPayload, topicShape()));
    const b = await w((db) =>
      insertSuggestion(db, 'auto_reply', { topicId: 't1', topicUpdatedAt: new Date(0).toISOString(), right: 5, counted: 5 }, shapeHashFor({ kind: 'auto_reply', topicId: 't1', topicUpdatedAt: new Date(0) })),
    );
    const c = await w((db) =>
      insertSuggestion(db, 'public_document', { documentId: 'd1', appliesTo: 'client', approvals: 3 }, shapeHashFor({ kind: 'public_document', documentId: 'd1' })),
    );
    expect(a?.kind).toBe('new_topic');
    expect(b?.payload).toEqual({ topicId: 't1', topicUpdatedAt: new Date(0).toISOString(), right: 5, counted: 5 });
    expect(c?.state).toBe('open');
    const open = await w((db) => listOpenSuggestions(db));
    expect(open.map((s) => s.kind)).toEqual(['new_topic', 'auto_reply', 'public_document']);
    const loaded = await w((db) => loadSuggestion(db, a!.suggestionId));
    expect(loaded?.payload).toEqual(topicPayload);
  });

  it('does not re-insert a shape, even after it was rejected', async () => {
    const first = await w((db) => insertSuggestion(db, 'new_topic', topicPayload, topicShape()));
    expect(await w((db) => insertSuggestion(db, 'new_topic', topicPayload, topicShape()))).toBeNull();
    await w((db) => decideSuggestion(db, first!.suggestionId, 'rejected', 'owner'));
    expect(await w((db) => insertSuggestion(db, 'new_topic', topicPayload, topicShape()))).toBeNull();
  });

  it('decides only once', async () => {
    const s = await w((db) => insertSuggestion(db, 'new_topic', topicPayload, topicShape()));
    expect(await w((db) => decideSuggestion(db, s!.suggestionId, 'accepted', 'owner'))).toBe(true);
    expect(await w((db) => decideSuggestion(db, s!.suggestionId, 'rejected', 'owner'))).toBe(false);
    expect((await w((db) => loadSuggestion(db, s!.suggestionId)))?.state).toBe('accepted');
  });

  it('deliveredOpenSuggestions filters by delivery, inbound, window, state', async () => {
    const mk = async (name: string) =>
      (await w((db) => insertSuggestion(db, 'new_topic', { ...topicPayload, name }, shapeHashFor({ kind: 'new_topic', name }))))!;
    const undelivered = await mk('u');
    const good = await mk('g');
    const late = await mk('l');
    const old = await mk('o');
    const decided = await mk('d');
    const inbound = new Date();
    const at = (ms: number) => new Date(inbound.getTime() + ms);
    await setDeliveredAt(good.suggestionId, at(-60_000));
    await setDeliveredAt(late.suggestionId, at(60_000));
    await setDeliveredAt(old.suggestionId, at(-3 * 3600_000));
    await setDeliveredAt(decided.suggestionId, at(-60_000));
    await w((db) => decideSuggestion(db, decided.suggestionId, 'rejected', 'owner'));
    void undelivered;
    const got = await w((db) => deliveredOpenSuggestions(db, { inboundAt: inbound, windowMinutes: 30 }));
    expect(got.map((s) => s.suggestionId)).toEqual([good.suggestionId]);
    expect(await w((db) => deliveredOpenSuggestions(db, { inboundAt: null }))).toEqual([]);
  });

  it("never shows another business's rows", async () => {
    await w((db) => insertSuggestion(db, 'new_topic', topicPayload, topicShape()));
    expect(await withBusiness('other-biz', (db) => listOpenSuggestions(db))).toEqual([]);
    const { rows } = await testDb().query('SELECT 1 FROM contact_suggestions');
    expect(rows).toHaveLength(1);
  });

  it('markSuggestionDelivered stamps the database clock, and only on an open row', async () => {
    const mk = async (name: string) =>
      (await w((db) => insertSuggestion(db, 'new_topic', { ...topicPayload, name }, shapeHashFor({ kind: 'new_topic', name }))))!;
    const open = await mk('open');
    const gone = await mk('gone');
    await w((db) => decideSuggestion(db, gone.suggestionId, 'rejected', 'owner'));
    expect(await w((db) => markSuggestionDelivered(db, open.suggestionId))).toBe(true);
    expect(await w((db) => markSuggestionDelivered(db, gone.suggestionId))).toBe(false);
    const { rows } = await testDb().query<{ id: string; delivered_at: Date | null; skew: number | null }>(
      `SELECT suggestion_id AS id, delivered_at, abs(extract(epoch FROM now() - delivered_at)) AS skew
         FROM contact_suggestions ORDER BY suggestion_id`,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(Number(byId.get(open.suggestionId)?.skew)).toBeLessThan(60);
    expect(byId.get(gone.suggestionId)?.delivered_at).toBeNull();
  });

  it('normalises the topic name in the shape hash with NFKC', () => {
    // U+FB01 (ﬁ ligature) folds to "fi" under NFKC.
    expect(shapeHashFor({ kind: 'new_topic', name: 'ﬁles' })).toBe(shapeHashFor({ kind: 'new_topic', name: 'files' }));
  });

  it('normalises the topic name in the shape hash', () => {
    expect(shapeHashFor({ kind: 'new_topic', name: ' משלוחים  ' })).toBe(shapeHashFor({ kind: 'new_topic', name: 'משלוחים' }));
    expect(shapeHashFor({ kind: 'new_topic', name: 'A  B' })).toBe(shapeHashFor({ kind: 'new_topic', name: 'a b' }));
  });
});
