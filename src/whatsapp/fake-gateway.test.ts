import { describe, expect, it } from 'vitest';
import { createFakeGateway } from './fake-gateway.js';
import type { NormalizedInboundMessage } from './gateway.js';

function msg(providerMessageId: string, body: string): NormalizedInboundMessage {
  return {
    providerMessageId,
    senderNumber: '+972541234567',
    body,
    mediaKind: null,
    providerTimestamp: '2026-10-03T09:00:00.000Z',
  };
}

describe('FakeGateway', () => {
  /**
   * A double with a bug here produces green tests about nothing in every
   * task that drives it later — this is the one place that bug would be
   * caught.
   */
  it('delivers enqueued messages to the handler, in order, and pollOnce returns the count', async () => {
    const gateway = createFakeGateway();
    const received: string[] = [];
    gateway.onInbound(async (m) => {
      received.push(m.providerMessageId);
    });

    gateway.enqueue(msg('wamid.1', 'first'));
    gateway.enqueue(msg('wamid.2', 'second'));
    gateway.enqueue(msg('wamid.3', 'third'));

    const count = await gateway.pollOnce();

    expect(count).toBe(3);
    expect(received).toEqual(['wamid.1', 'wamid.2', 'wamid.3']);
  });

  /**
   * A fake that redelivers on an empty queue would hide a real dedupe bug
   * downstream, in every consumer that trusts `pollOnce`'s count.
   */
  it('delivers nothing and returns 0 on a second pollOnce with nothing queued', async () => {
    const gateway = createFakeGateway();
    const received: string[] = [];
    gateway.onInbound(async (m) => {
      received.push(m.providerMessageId);
    });

    gateway.enqueue(msg('wamid.1', 'only one'));
    const first = await gateway.pollOnce();
    const second = await gateway.pollOnce();

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(received).toEqual(['wamid.1']);
  });

  it('leaves a queued message undelivered, not dropped, when no handler is registered yet', async () => {
    const gateway = createFakeGateway();
    gateway.enqueue(msg('wamid.1', 'waiting'));

    const beforeHandler = await gateway.pollOnce();
    expect(beforeHandler).toBe(0);

    const received: string[] = [];
    gateway.onInbound(async (m) => {
      received.push(m.providerMessageId);
    });
    const afterHandler = await gateway.pollOnce();

    expect(afterHandler).toBe(1);
    expect(received).toEqual(['wamid.1']);
  });

  it('records every sendMessage call, in order', async () => {
    const gateway = createFakeGateway();

    await gateway.sendMessage({ contactId: 'c1', body: 'hello', idempotencyKey: 'k1' });
    await gateway.sendMessage({ contactId: 'c2', body: 'world', idempotencyKey: 'k2' });

    expect(gateway.sent).toEqual([
      { contactId: 'c1', body: 'hello', idempotencyKey: 'k1' },
      { contactId: 'c2', body: 'world', idempotencyKey: 'k2' },
    ]);
  });

  it('makes exactly one sendMessage call reject after failNextSend, never throwing', async () => {
    const gateway = createFakeGateway();
    gateway.failNextSend();

    const first = await gateway.sendMessage({ contactId: 'c1', body: 'hello', idempotencyKey: 'k1' });
    expect(first.state).toBe('rejected');

    const second = await gateway.sendMessage({ contactId: 'c1', body: 'retry', idempotencyKey: 'k2' });
    expect(second.state).toBe('sent');

    // The rejected call must not have been recorded as sent.
    expect(gateway.sent).toEqual([{ contactId: 'c1', body: 'retry', idempotencyKey: 'k2' }]);
  });

  it('returns whatever health was last set', async () => {
    const gateway = createFakeGateway();

    expect((await gateway.health()).state).toBe('connected');

    gateway.setHealth({ state: 'qr_required', since: '2026-10-03T10:00:00.000Z' });
    const health = await gateway.health();
    expect(health.state).toBe('qr_required');
    expect(health.since).toBe('2026-10-03T10:00:00.000Z');
  });

  it('canSendFreeform always returns true in this fake', async () => {
    const gateway = createFakeGateway();
    expect(await gateway.canSendFreeform('any-contact')).toBe(true);
  });
});
