/**
 * The scheduler builds suggestions and then delivers one on WhatsApp — only
 * when the contact flow is wired (signed connection, adapter registered).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { ContactClusterer } from '../sdk/contact-clusterer.js';
import { createFakeGateway } from '../whatsapp/fake-gateway.js';
import { insertSuggestion, listOpenSuggestions, shapeHashFor } from '../whatsapp/contact-suggestions.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createWhatsAppContactsAdapter } from './adapters/whatsapp-contacts.js';
import { envCredentials } from './credentials.js';
import { schedulerPass } from './scheduler.js';
import type { Runtime } from './runtime.js';

beforeEach(async () => {
  await resetDatabase();
  await withBusiness(TEST_BUSINESS, (db) => installCharter(db, buildCharter()));
});
afterAll(async () => {
  await closePool();
});

async function decision(): Promise<void> {
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
     VALUES ($1,$2,$3,$4,$5,'right',NULL,'{}',now(),NULL,'מתי המשלוח מגיע','{}',NULL)`,
    [TEST_BUSINESS, ulid(), conv, ulid(), ulid()],
  );
}

let calls = 0;
const clusterer: ContactClusterer = async (req) => {
  calls++;
  return {
    status: 'ok',
    raw: { groups: [{ name: 'משלוחים', description: 'שאלות על משלוחים', indexes: req.summaries.map((s) => s.index) }] },
  };
};

function runtime(gateway: ReturnType<typeof createFakeGateway>, wired: boolean): Runtime {
  return {
    registry: new AdapterRegistry(
      wired
        ? [createWhatsAppContactsAdapter({ gateway, conversationNumber: async () => null, recordOutbound: async () => {} })]
        : [],
    ),
    credentials: envCredentials({}, 'TEST_CRED_'),
    warnings: [],
    whatsapp: { gateway },
  };
}

describe('schedulerPass — suggestions', () => {
  beforeEach(() => {
    calls = 0;
  });

  it('wired: builds suggestions and delivers one through the boss messenger', async () => {
    for (let i = 0; i < 5; i++) await decision();
    const gateway = createFakeGateway();
    await schedulerPass(TEST_BUSINESS, { inbox: null, runtime: runtime(gateway, true), contactClusterer: clusterer });
    expect(calls).toBe(1);
    const open = await withBusiness(TEST_BUSINESS, (db) => listOpenSuggestions(db));
    expect(open).toHaveLength(1);
    expect(open[0]?.deliveredAt).toBeInstanceOf(Date);
    const suggestionMessages = gateway.sent.filter((m) => m.body.includes('משלוחים'));
    expect(suggestionMessages).toHaveLength(1);
  });

  it('unwired: neither builds nor delivers', async () => {
    for (let i = 0; i < 5; i++) await decision();
    // An already-open suggestion stays undelivered too.
    await withBusiness(TEST_BUSINESS, (db) =>
      insertSuggestion(db, 'new_topic', { name: 'החזרות', description: '', appliesTo: 'client', sources: [], decisionIds: [] },
        shapeHashFor({ kind: 'new_topic', name: 'החזרות' })),
    );
    const gateway = createFakeGateway();
    await schedulerPass(TEST_BUSINESS, { inbox: null, runtime: runtime(gateway, false), contactClusterer: clusterer });
    expect(calls).toBe(0);
    const open = await withBusiness(TEST_BUSINESS, (db) => listOpenSuggestions(db));
    expect(open.map((s) => s.deliveredAt)).toEqual([null]);
    expect(gateway.sent.filter((m) => m.body.includes('משלוחים') || m.body.includes('החזרות'))).toHaveLength(0);
  });
});
