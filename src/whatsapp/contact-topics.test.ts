import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { createTopic, listTopics, retireTopic, topicApplies, setTopicAutoReply, loadTopic } from './contact-topics.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

const base = {
  name: 'שעות פתיחה',
  description: '',
  appliesTo: 'both' as const,
  sources: ['public' as const],
  autoReply: false,
  by: 'owner',
};

describe('contact topics', () => {
  it('rejects an unknown source with no row written', async () => {
    await expect(
      withBusiness(TEST_BUSINESS, (db) => createTopic(db, { ...base, sources: ['bogus' as never] })),
    ).rejects.toThrow(/מקור/);
    const { rows } = await testDb().query('SELECT 1 FROM contact_topics');
    expect(rows).toHaveLength(0);
  });

  it('rejects an empty name', async () => {
    await expect(withBusiness(TEST_BUSINESS, (db) => createTopic(db, { ...base, name: '  ' }))).rejects.toThrow(/שם/);
  });

  it('round trips, toggles auto reply and retires', async () => {
    const t = await withBusiness(TEST_BUSINESS, (db) => createTopic(db, base));
    expect((await withBusiness(TEST_BUSINESS, (db) => loadTopic(db, t.topicId)))?.autoReply).toBe(false);
    expect(await withBusiness(TEST_BUSINESS, (db) => setTopicAutoReply(db, t.topicId, true, 'owner'))).toBe(true);
    expect((await withBusiness(TEST_BUSINESS, (db) => loadTopic(db, t.topicId)))?.autoReply).toBe(true);
    expect(await withBusiness(TEST_BUSINESS, (db) => retireTopic(db, t.topicId, 'owner'))).toBe(true);
    expect(await withBusiness(TEST_BUSINESS, (db) => listTopics(db))).toHaveLength(0);
    const all = await withBusiness(TEST_BUSINESS, (db) => listTopics(db, { includeRetired: true }));
    expect(all).toHaveLength(1);
    expect(all[0]?.retiredAt).not.toBeNull();
    const { rows } = await testDb().query(
      `SELECT reason FROM audit_log WHERE reason LIKE 'contact_topic:%' ORDER BY seq`,
    );
    expect(rows.map((r: { reason: string }) => r.reason)).toEqual([
      'contact_topic:created',
      'contact_topic:auto_on',
      'contact_topic:retired',
    ]);
  });

  it('topicApplies', () => {
    const t = (appliesTo: 'client' | 'supplier' | 'both') => ({
      topicId: 'x',
      name: 'n',
      description: '',
      appliesTo,
      sources: [],
      autoReply: false,
      retiredAt: null,
    });
    expect(topicApplies(t('both'), 'supplier')).toBe(true);
    expect(topicApplies(t('client'), 'supplier')).toBe(false);
    expect(topicApplies(t('client'), 'client')).toBe(true);
  });
});
