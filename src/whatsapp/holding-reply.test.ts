import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { compileCharter } from '../charter/compile.js';
import { appendAudit, queryAudit } from '../audit/log.js';
import { trip } from '../governance/killswitch.js';
import type { PolicyBundle } from '../domain/policy.js';
import { canonicalHash } from '../util/canonical.js';
import { buildCharter } from '../test/fixtures.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { loadConversation, openOrAppend } from './contact-conversations.js';
import { createFakeGateway } from './fake-gateway.js';
import { HOLDING_REPLY_TEXT, sendDueHoldingReplies, sendHoldingReply } from './holding-reply.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

const KEY = '972501110001';
const NAME = 'דוגמה';
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
    sendHoldingReply(db, { gateway: gw, bundle, businessName: NAME, now }, id),
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
      sendDueHoldingReplies(db, { gateway: gw, bundle: open, businessName: NAME, now: new Date() }),
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
});
