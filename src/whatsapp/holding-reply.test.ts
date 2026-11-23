import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { compileCharter } from '../charter/compile.js';
import { appendAudit, queryAudit } from '../audit/log.js';
import { release, trip } from '../governance/killswitch.js';
import type { PolicyBundle } from '../domain/policy.js';
import { canonicalHash } from '../util/canonical.js';
import { buildCharter } from '../test/fixtures.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { loadConversation, openOrAppend } from './contact-conversations.js';
import { createFakeGateway } from './fake-gateway.js';
import { HOLDING_REPLY_TEXT, sendDueHoldingReplies, sendHoldingReply } from './holding-reply.js';

beforeEach(async () => {
  await resetDatabase();
  await setName(NAME);
});
afterAll(async () => {
  await closePool();
});

const KEY = '972501110001';
const NAME = 'דוגמה';
async function setName(name: string | null): Promise<void> {
  await testDb().query(
    `INSERT INTO business_profiles (business_id, display_name, updated_by) VALUES ($1, $2, 'test')
     ON CONFLICT (business_id) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [TEST_BUSINESS, name],
  );
}
const baseBundle = compileCharter(buildCharter());
const open: PolicyBundle = { ...baseBundle, quietHours: null };
const ago = (m: number) => new Date(Date.now() - m * 60_000);

async function conv(inboundAt: Date, key = KEY): Promise<string> {
  const r = await withBusiness(TEST_BUSINESS, (db) =>
    openOrAppend(db, { key, subjectKey: null, kind: 'client', inboundAt }),
  );
  return r.conversation.conversationId;
}
const run = (gw: ReturnType<typeof createFakeGateway>, id: string, bundle = open, now = new Date()) =>
  withBusiness(TEST_BUSINESS, (db) =>
    sendHoldingReply(db, { gateway: gw, bundle, now }, id),
  );

describe('holding reply', () => {
  it('sent: constant text to the conversation number, recorded', async () => {
    const gw = createFakeGateway();
    const id = await conv(ago(5));
    expect(await run(gw, id)).toBe('sent');
    expect(gw.sent).toEqual([
      { contactId: KEY, body: HOLDING_REPLY_TEXT(NAME), idempotencyKey: `holding:${id}` },
    ]);
    const c = await withBusiness(TEST_BUSINESS, (db) => loadConversation(db, id));
    expect(c?.holdingSentAt).not.toBeNull();
    const { rows } = await testDb().query(`SELECT 1 FROM whatsapp_messages WHERE direction = 'outbound'`);
    expect(rows).toHaveLength(1);
  });

  it('already: a second call sends nothing', async () => {
    const gw = createFakeGateway();
    const id = await conv(ago(5));
    await run(gw, id);
    expect(await run(gw, id)).toBe('already');
    expect(gw.sent).toHaveLength(1);
  });

  it('stale: last inbound older than 60 minutes', async () => {
    const gw = createFakeGateway();
    expect(await run(gw, await conv(ago(61)))).toBe('stale');
    expect(gw.sent).toHaveLength(0);
  });

  it('halted: outbound kill switch', async () => {
    const gw = createFakeGateway();
    const id = await conv(ago(5));
    await withBusiness(TEST_BUSINESS, (db) => trip(db, 'outbound', 'test', 'stop'));
    expect(await run(gw, id)).toBe('halted');
    expect(gw.sent).toHaveLength(0);
  });

  it('halted is a deferral: after release a later pass still sends it', async () => {
    const gw = createFakeGateway();
    const id = await conv(ago(5));
    await withBusiness(TEST_BUSINESS, (db) => trip(db, 'all', 'test', 'stop'));
    expect(await run(gw, id)).toBe('halted');
    const c = await withBusiness(TEST_BUSINESS, (db) => loadConversation(db, id));
    expect(c?.holdingDueAt).not.toBeNull();
    await withBusiness(TEST_BUSINESS, (db) => release(db, 'all', 'test', 'ok'));
    const later = new Date(Date.now() + 6 * 60_000);
    const out = await withBusiness(TEST_BUSINESS, (db) =>
      sendDueHoldingReplies(db, { gateway: gw, bundle: open, now: later }),
    );
    expect(out.sent).toBe(1);
    expect(gw.sent).toHaveLength(1);
  });

  it('capped: three holdings to the number today', async () => {
    const gw = createFakeGateway();
    for (let i = 0; i < 3; i += 1) {
      await withBusiness(TEST_BUSINESS, (db) =>
        appendAudit(db, {
          actor: 'comms.whatsapp',
          kind: 'tool_call',
          charterVersion: open.charterVersion,
          provenance: 'unknown_external',
          inputHash: canonicalHash({ key: KEY }),
          reason: 'contact_holding_reply',
        }),
      );
    }
    expect(await run(gw, await conv(ago(5)))).toBe('capped');
    expect(gw.sent).toHaveLength(0);
  });

  it('deferred inside quiet hours to their end', async () => {
    const gw = createFakeGateway();
    // 23:00 Jerusalem in winter = 21:00Z; the fixture window is 20:00-07:00.
    const night = new Date(Date.UTC(2026, 0, 15, 21, 0));
    const id = await conv(new Date(night.getTime() - 60_000));
    const quiet = {
      ...baseBundle,
      quietHours: { from: '20:00', to: '07:00', timezone: 'Asia/Jerusalem', appliesTo: ['whatsapp'] },
    } as typeof baseBundle;
    expect(await run(gw, id, quiet, night)).toBe('deferred');
    expect(gw.sent).toHaveLength(0);
    const c = await withBusiness(TEST_BUSINESS, (db) => loadConversation(db, id));
    expect(c?.holdingDueAt?.toISOString()).toBe('2026-01-16T05:00:00.000Z');
  });

  it('sendDue picks only due, unsent rows', async () => {
    const gw = createFakeGateway();
    const due = await conv(ago(5));
    await conv(ago(5), '972501110002'); // not due
    await testDb().query(
      `UPDATE contact_conversations SET holding_due_at = now() - interval '1 minute' WHERE conversation_id = $1`,
      [due],
    );
    const r = await withBusiness(TEST_BUSINESS, (db) =>
      sendDueHoldingReplies(db, { gateway: gw, bundle: open, now: new Date() }),
    );
    expect(r).toEqual({ sent: 1, failed: 0 });
    expect(gw.sent).toHaveLength(1);
  });

  it('failure is retried on the next pass and never sent twice after success', async () => {
    const gw = createFakeGateway();
    const id = await conv(ago(5));
    gw.throwNextSend();
    expect(await run(gw, id)).toBe('failed');
    const c = await withBusiness(TEST_BUSINESS, (db) => loadConversation(db, id));
    expect(c?.holdingSentAt).toBeNull();
    gw.failNextSend();
    expect(await run(gw, id)).toBe('failed');
    expect(await run(gw, id)).toBe('sent');
    expect(await run(gw, id)).toBe('already');
    expect(gw.sent).toHaveLength(1);
  });

  it('a failed first attempt is retried by the scheduler pass five minutes later, once', async () => {
    const gw = createFakeGateway();
    const id = await conv(ago(5));
    const t0 = new Date();
    gw.throwNextSend();
    expect(await run(gw, id, open, t0)).toBe('failed');
    const sweep = (at: Date) =>
      withBusiness(TEST_BUSINESS, (db) => sendDueHoldingReplies(db, { gateway: gw, bundle: open, now: at }));
    expect(await sweep(new Date(t0.getTime() + 60_000))).toEqual({ sent: 0, failed: 0 });
    expect(await sweep(new Date(t0.getTime() + 5 * 60_000 + 1000))).toEqual({ sent: 1, failed: 0 });
    expect(await sweep(new Date(t0.getTime() + 10 * 60_000))).toEqual({ sent: 0, failed: 0 });
    expect(gw.sent).toHaveLength(1);
  });

  it('a throw after the claim releases it and defers the retry', async () => {
    const gw = createFakeGateway();
    const id = await conv(ago(5));
    let countQueries = 0;
    const out = await withBusiness(TEST_BUSINESS, (db) => {
      const flaky = Object.create(db) as typeof db;
      flaky.query = ((sql: string, params?: unknown[]) => {
        if (/count\(\*\)[\s\S]*FROM contact_conversations/.test(sql)) {
          countQueries += 1;
          if (countQueries === 2) throw new Error('db blip');
        }
        return db.query(sql, params as never);
      }) as typeof db.query;
      return sendHoldingReply(flaky, { gateway: gw, bundle: open, now: new Date() }, id);
    });
    expect(out).toBe('failed');
    expect(gw.sent).toHaveLength(0);
    const c = await withBusiness(TEST_BUSINESS, (db) => loadConversation(db, id));
    expect(c?.holdingSentAt).toBeNull();
    expect(c?.holdingDueAt).not.toBeNull();
    expect(await run(gw, id)).toBe('sent');
  });

  it('retries stop once the contact has been silent for 24 hours', async () => {
    const gw = createFakeGateway();
    const id = await conv(ago(5));
    gw.throwNextSend();
    const t0 = new Date();
    expect(await run(gw, id, open, t0)).toBe('failed');
    const later = new Date(t0.getTime() + 25 * 3600_000);
    const r = await withBusiness(TEST_BUSINESS, (db) =>
      sendDueHoldingReplies(db, { gateway: gw, bundle: open, now: later }),
    );
    expect(r).toEqual({ sent: 0, failed: 0 });
    const c = await withBusiness(TEST_BUSINESS, (db) => loadConversation(db, id));
    expect(c?.holdingDueAt).toBeNull();
    expect(gw.sent).toHaveLength(0);
    // And a failure after 24h does not defer again.
    const old = await conv(ago(25 * 60), '972501110002');
    gw.throwNextSend();
    expect(await run(gw, old, open, new Date())).toBe('stale');
  });

  it('two concurrent calls send exactly once', async () => {
    const gw = createFakeGateway();
    const id = await conv(ago(5));
    const outcomes = await Promise.all([run(gw, id), run(gw, id)]);
    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(1);
    expect(gw.sent).toHaveLength(1);
  });

  it('the business name is read from the profile and made one clean line', async () => {
    await setName('אלפא‮\nבע"מ');
    const gw = createFakeGateway();
    await run(gw, await conv(ago(5)));
    const body = gw.sent[0]?.body ?? '';
    expect(body).not.toMatch(/[‮\n]/);
    expect(body).toContain('אלפא');
  });

  it('falls back to a generic name when the profile has none', async () => {
    await setName(null);
    const gw = createFakeGateway();
    await run(gw, await conv(ago(5)));
    expect(gw.sent[0]?.body).toBe(HOLDING_REPLY_TEXT('העסק'));
  });

  it('audit row carries no number or text', async () => {
    const gw = createFakeGateway();
    await run(gw, await conv(ago(5)));
    const rows = await withBusiness(TEST_BUSINESS, (db) => queryAudit(db, { kind: 'tool_call' }));
    expect(rows).toHaveLength(1);
    const blob = JSON.stringify(rows[0], (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    expect(blob).not.toContain(KEY);
    expect(blob).not.toContain('קיבלתי');
    expect(rows[0]?.reason).toBe('contact_holding_reply');
  });

  it('a deferred reply goes out at quiet-hours end while the question is open, once', async () => {
    const gw = createFakeGateway();
    const night = new Date(Date.UTC(2026, 0, 15, 21, 30));
    const id = await conv(night);
    const quiet = { ...baseBundle, quietHours: { from: '20:00', to: '07:00', timezone: 'Asia/Jerusalem', appliesTo: ['whatsapp'] } } as typeof baseBundle;
    expect(await run(gw, id, quiet, night)).toBe('deferred');
    const morning = new Date(Date.UTC(2026, 0, 16, 5, 0));
    const pass = () => withBusiness(TEST_BUSINESS, (db) => sendDueHoldingReplies(db, { gateway: gw, bundle: quiet, now: morning }));
    expect(await pass()).toEqual({ sent: 1, failed: 0 });
    expect(await pass()).toEqual({ sent: 0, failed: 0 });
    expect(gw.sent).toHaveLength(1);
  });

  it('a deferred reply is not sent when the conversation was closed meanwhile', async () => {
    const gw = createFakeGateway();
    const night = new Date(Date.UTC(2026, 0, 15, 21, 30));
    const id = await conv(night);
    const quiet = { ...baseBundle, quietHours: { from: '20:00', to: '07:00', timezone: 'Asia/Jerusalem', appliesTo: ['whatsapp'] } } as typeof baseBundle;
    expect(await run(gw, id, quiet, night)).toBe('deferred');
    await testDb().query(`UPDATE contact_conversations SET state = 'closed' WHERE conversation_id = $1`, [id]);
    const morning = new Date(Date.UTC(2026, 0, 16, 5, 0));
    await withBusiness(TEST_BUSINESS, (db) => sendDueHoldingReplies(db, { gateway: gw, bundle: quiet, now: morning }));
    expect(gw.sent).toHaveLength(0);
  });

  it('a stale first attempt under a tripped kill switch is dropped as stale, not deferred (I3)', async () => {
    const gw = createFakeGateway();
    const id = await conv(ago(61));
    await withBusiness(TEST_BUSINESS, (db) => trip(db, 'all', 'test', 'stop'));
    expect(await run(gw, id)).toBe('stale');
    const c = await withBusiness(TEST_BUSINESS, (db) => loadConversation(db, id));
    expect(c?.holdingDueAt).toBeNull();
    // Positive control: the same switch, a fresh first attempt — halted and deferred.
    const fresh = await conv(ago(5), '972501110002');
    expect(await run(gw, fresh)).toBe('halted');
    const f = await withBusiness(TEST_BUSINESS, (db) => loadConversation(db, fresh));
    expect(f?.holdingDueAt).not.toBeNull();
    expect(gw.sent).toHaveLength(0);
  });

  it('a first attempt on a conversation that is no longer open is not sent (I3)', async () => {
    const gw = createFakeGateway();
    const id = await conv(ago(5));
    await testDb().query(`UPDATE contact_conversations SET state = 'answered' WHERE conversation_id = $1`, [id]);
    expect(await run(gw, id)).toBe('stale');
    expect(gw.sent).toHaveLength(0);
    // Positive control: the same fresh first attempt on an open conversation is sent.
    const other = await conv(ago(5), '972501110003');
    expect(await run(gw, other)).toBe('sent');
    expect(gw.sent).toHaveLength(1);
  });
});
