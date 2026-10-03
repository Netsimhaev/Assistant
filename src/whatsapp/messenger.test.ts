import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import type { Queryable } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { createFakeGateway } from './fake-gateway.js';
import { createBossMessenger } from './messenger.js';
import { conversation } from './store.js';

const BUSINESS = 'test-business';
const CONTACT_ID = '972541234567';

describe('createBossMessenger', () => {
  beforeEach(async () => { await resetDatabase(); });
  afterAll(async () => { await closePool(); });

  it('sends to the configured principal and records the outbound row', async () => {
    const gateway = createFakeGateway();
    const messenger = createBossMessenger({ gateway, contactId: CONTACT_ID, businessId: BUSINESS });

    const outcome = await messenger.send({ text: 'קיבלתי.', jobId: 'J-1' });

    expect(outcome).toEqual({ ok: true });
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]).toMatchObject({ contactId: CONTACT_ID, body: 'קיבלתי.' });

    const convo = await conversation({ businessId: BUSINESS });
    expect(convo).toHaveLength(1);
    expect(convo[0]).toMatchObject({
      direction: 'outbound', body: 'קיבלתי.', jobId: 'J-1', state: 'handled',
    });
  });

  /**
   * Same contract as the approval notifier's: a failed notification never
   * fails the work. The instruction was received and recorded; the phone not
   * hearing about it is a separate fact.
   */
  it('returns ok:false instead of throwing when the gateway rejects', async () => {
    const gateway = createFakeGateway();
    gateway.failNextSend();
    const messenger = createBossMessenger({ gateway, contactId: CONTACT_ID, businessId: BUSINESS });
    await expect(messenger.send({ text: 'קיבלתי.', jobId: null })).resolves.toMatchObject({ ok: false });
  });

  /**
   * There is no recipient parameter, and that is the control, not a
   * convenience. The moment the assistant can be asked to send WhatsApp to
   * an arbitrary number, it is an agent action that must go through the
   * gate with an action class, charter rate ceilings and a doNotContact
   * check — sub-project ג'. A compile-time absence is the boundary.
   */
  it('exposes no way to name a different recipient', () => {
    const messenger = createBossMessenger({ gateway: createFakeGateway(), contactId: CONTACT_ID, businessId: BUSINESS });
    expect(Object.keys(messenger)).toEqual(['channel', 'send']);
  });

  /**
   * Fix round 1, Important 1: `recordOutbound` always creates the row as
   * `'handled'`, so without a follow-up `settleMessage` a rejected send and
   * a delivered one were byte-identical on the conversation screen — the
   * owner would see the acknowledgement as sent when it never left the
   * gateway. The row must read `'failed'`, not `'handled'`.
   */
  it('still records the outbound row when the send failed, marked failed rather than handled', async () => {
    const gateway = createFakeGateway();
    gateway.failNextSend();
    const messenger = createBossMessenger({ gateway, contactId: CONTACT_ID, businessId: BUSINESS });

    const outcome = await messenger.send({ text: 'הניסיון נכשל', jobId: 'J-2' });
    expect(outcome.ok).toBe(false);

    const convo = await conversation({ businessId: BUSINESS });
    expect(convo).toHaveLength(1);
    expect(convo[0]).toMatchObject({
      direction: 'outbound', body: 'הניסיון נכשל', jobId: 'J-2', state: 'failed',
    });
  });

  /**
   * A thrown transport error — distinct from a `{ state: 'rejected' }`
   * result, see `fake-gateway.ts`'s `throwNextSend` — must leave the same
   * honest trace: `send` resolves `{ ok: false }` rather than rejecting,
   * and the row still reads `'failed'`.
   */
  it('returns ok:false and still records a failed row when the gateway throws outright', async () => {
    const gateway = createFakeGateway();
    gateway.throwNextSend();
    const messenger = createBossMessenger({ gateway, contactId: CONTACT_ID, businessId: BUSINESS });

    const outcome = await messenger.send({ text: 'תקלת רשת', jobId: 'J-3' });
    expect(outcome.ok).toBe(false);

    const convo = await conversation({ businessId: BUSINESS });
    expect(convo).toHaveLength(1);
    expect(convo[0]).toMatchObject({
      direction: 'outbound', body: 'תקלת רשת', jobId: 'J-3', state: 'failed',
    });
  });

  /**
   * This assertion alone does not prove business isolation: the write path
   * only ever targets the one `businessId` passed to `createBossMessenger`,
   * so no plausible mutation inside this module flips which business a row
   * lands under — this test would pass even against an implementation that
   * silently dropped `businessId` and fell back to configuration. The test
   * that actually guards against that mutation is the FIRST test in this
   * file: `config.businessId` is `dev-business` in this project's test
   * environment while every test here uses `test-business`, so a
   * `recordOutbound`/`settleMessage` call that dropped `{ businessId }`
   * would make that test's own `conversation({ businessId: BUSINESS })`
   * come back empty instead of with one row. This test stays for
   * documentation, and for the narrower, real case of someone removing the
   * business filter from `conversation` itself in `store.ts`.
   */
  it('confines the recorded row to its own business', async () => {
    const gateway = createFakeGateway();
    const messenger = createBossMessenger({ gateway, contactId: CONTACT_ID, businessId: BUSINESS });
    await messenger.send({ text: 'קיבלתי.', jobId: null });
    expect(await conversation({ businessId: 'other-business' })).toEqual([]);
  });

  // --- Fix round 1, Important 2: three brief-specified behaviours that no
  // test could previously fail against (deleting the race, a constant
  // idempotency key, and moving the attempt-recording write outside its own
  // failure boundary all passed every test written up to that point). Each
  // test below is paired with a named mutation in the task report.

  /**
   * The gateway call is raced against a deadline rather than awaited
   * directly. `hangNextSend` makes the fake behave like a transport that
   * never settles — `AbortSignal` cannot bound this on its own, because
   * `WhatsAppGateway.sendMessage` takes no signal at all; only the race
   * itself can. Same pattern as `notify.test.ts`'s own hang test: a
   * generous margin over the 5s deadline (`SEND_TIMEOUT_MS`), and a longer
   * test-level timeout so the assertion — not vitest's default — is what
   * would fail if the race were removed.
   */
  it('gives up on a gateway that never settles, within the deadline, instead of hanging forever', async () => {
    const gateway = createFakeGateway();
    gateway.hangNextSend();
    const messenger = createBossMessenger({ gateway, contactId: CONTACT_ID, businessId: BUSINESS });

    const started = Date.now();
    const outcome = await messenger.send({ text: 'קיבלתי.', jobId: null });
    const elapsedMs = Date.now() - started;

    expect(outcome.ok).toBe(false);
    expect(elapsedMs).toBeLessThan(9_000);
  }, 15_000);

  /**
   * The idempotency key folds in the wall-clock minute. A retry of the same
   * acknowledgement a full hour later must get a key of its own — a
   * constant key (or one that drops `minute` from the hash) would make a
   * real gateway dedupe every later send against the first one, and the
   * owner would silently stop hearing anything past the first message.
   */
  it('gives two sends of identical text an hour apart different idempotency keys', async () => {
    const gateway = createFakeGateway();
    const times = [
      new Date('2026-10-03T09:00:10.000Z'),
      new Date('2026-10-03T10:00:10.000Z'),
    ];
    let callIndex = 0;
    const messenger = createBossMessenger({
      gateway,
      contactId: CONTACT_ID,
      businessId: BUSINESS,
      now: () => times[Math.min(callIndex++, times.length - 1)] ?? new Date(),
    });

    await messenger.send({ text: 'קיבלתי.', jobId: 'J-1' });
    await messenger.send({ text: 'קיבלתי.', jobId: 'J-1' });

    expect(gateway.sent).toHaveLength(2);
    const [first, second] = gateway.sent;
    expect(first?.idempotencyKey).toBeTruthy();
    expect(second?.idempotencyKey).toBeTruthy();
    expect(first?.idempotencyKey).not.toBe(second?.idempotencyKey);
  });

  /**
   * Recording the attempt is best-effort: a database failure while writing
   * the row must not override the gateway's real, successful outcome.
   * Proving it requires actually making the write fail, via the same
   * `{ db }` escape hatch `recordOutbound`/`settleMessage` already expose
   * for tests — an always-rejecting `Queryable` stands in for a lost
   * connection.
   */
  it('still reports a successful send even when recording the attempt fails', async () => {
    const gateway = createFakeGateway();
    const refusingDb: Queryable = {
      query: (() => Promise.reject(new Error('injected db failure'))) as Queryable['query'],
    };
    const messenger = createBossMessenger({
      gateway, contactId: CONTACT_ID, businessId: BUSINESS, db: refusingDb,
    });

    const outcome = await messenger.send({ text: 'קיבלתי.', jobId: null });
    expect(outcome).toEqual({ ok: true });
  });
});
