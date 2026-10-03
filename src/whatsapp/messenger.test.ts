import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
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
    expect(convo[0]).toMatchObject({ direction: 'outbound', body: 'קיבלתי.', jobId: 'J-1' });
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

  it('still records the outbound row when the send failed, so the dashboard shows the attempt', async () => {
    const gateway = createFakeGateway();
    gateway.failNextSend();
    const messenger = createBossMessenger({ gateway, contactId: CONTACT_ID, businessId: BUSINESS });

    const outcome = await messenger.send({ text: 'הניסיון נכשל', jobId: 'J-2' });
    expect(outcome.ok).toBe(false);

    const convo = await conversation({ businessId: BUSINESS });
    expect(convo).toHaveLength(1);
    expect(convo[0]).toMatchObject({ direction: 'outbound', body: 'הניסיון נכשל', jobId: 'J-2' });
  });

  it('confines the recorded row to its own business', async () => {
    const gateway = createFakeGateway();
    const messenger = createBossMessenger({ gateway, contactId: CONTACT_ID, businessId: BUSINESS });
    await messenger.send({ text: 'קיבלתי.', jobId: null });
    expect(await conversation({ businessId: 'other-business' })).toEqual([]);
  });
});
