/**
 * An in-memory double for {@link WhatsAppGateway}, for every later task's
 * tests to drive instead of a real WhatsApp connection.
 *
 * `pollOnce` only ever delivers what `enqueue` put there, and only once: it
 * splices the whole queue out before iterating, so a message delivered in
 * one call is gone from the queue and cannot be redelivered by a second
 * call. A fake that redelivered would hide a real dedupe bug downstream —
 * the kind `whatsapp_messages_provider_idx` (`src/whatsapp/store.ts`) exists
 * to catch for real.
 */
import type { GatewayHealth, NormalizedInboundMessage, WhatsAppGateway } from './gateway.js';

export interface FakeGateway extends WhatsAppGateway {
  /** Queue a message for the next `pollOnce`. */
  enqueue(msg: NormalizedInboundMessage): void;
  /** Everything `sendMessage` was asked to send, in order. */
  readonly sent: Array<{ contactId: string; body: string; idempotencyKey: string }>;
  setHealth(health: GatewayHealth): void;
  /**
   * Makes the next `sendMessage` call *resolve* with `{ state: 'rejected' }`
   * — the gateway's own, non-throwing way of saying a message did not go
   * out (think: the provider's API answered "rejected"). This is **not** a
   * thrown error; a caller that only catches exceptions and never reads
   * `result.state` would miss it entirely. For an actual rejected promise —
   * a DNS failure, `ECONNREFUSED`, anything a transport throws — use
   * {@link throwNextSend}.
   */
  failNextSend(): void;
  /**
   * Makes the next `sendMessage` call *reject* with an `Error`, the way a
   * real network failure (DNS, `ECONNREFUSED`, a dropped socket) would — as
   * opposed to {@link failNextSend}, which resolves normally with a
   * `'rejected'` status. Affects exactly one call, same as `failNextSend`.
   */
  throwNextSend(): void;
  /**
   * Makes the next `sendMessage` call return a promise that never settles —
   * neither resolves nor rejects — so a caller's own deadline is the only
   * thing that can end the wait. Affects exactly one call, same as
   * `failNextSend`; the call *after* the hanging one behaves normally.
   */
  hangNextSend(): void;
}

export function createFakeGateway(): FakeGateway {
  const queue: NormalizedInboundMessage[] = [];
  const sent: Array<{ contactId: string; body: string; idempotencyKey: string }> = [];
  let handler: ((msg: NormalizedInboundMessage) => Promise<void>) | null = null;
  let health: GatewayHealth = { state: 'connected', since: new Date().toISOString() };
  let failNext = false;
  let throwNext = false;
  let hangNext = false;
  let nextMessageId = 0;

  return {
    async canSendFreeform(): Promise<boolean> {
      // This fake stands in for the unofficial bridge, which never refuses
      // freeform text. A test that needs the Meta-style 24-hour restriction
      // exercises a different double, not this one.
      return true;
    },

    async sendMessage(input) {
      if (hangNext) {
        hangNext = false;
        return new Promise(() => {
          // Deliberately never settles — the point of `hangNextSend`.
        });
      }
      if (throwNext) {
        throwNext = false;
        throw new Error('fake-gateway: forced transport failure');
      }
      if (failNext) {
        failNext = false;
        return { messageId: '', state: 'rejected' };
      }
      sent.push({ contactId: input.contactId, body: input.body, idempotencyKey: input.idempotencyKey });
      nextMessageId += 1;
      return { messageId: `fake-msg-${nextMessageId}`, state: 'sent' };
    },

    async health(): Promise<GatewayHealth> {
      return health;
    },

    onInbound(h) {
      handler = h;
    },

    async pollOnce(): Promise<number> {
      // No handler registered yet: nothing is delivered, and nothing is
      // lost — the queue is left intact for a later `pollOnce` once a
      // handler exists.
      if (handler === null) return 0;
      const batch = queue.splice(0, queue.length);
      for (const msg of batch) {
        await handler(msg);
      }
      return batch.length;
    },

    enqueue(msg) {
      queue.push(msg);
    },

    sent,

    setHealth(h) {
      health = h;
    },

    failNextSend() {
      failNext = true;
    },

    throwNextSend() {
      throwNext = true;
    },

    hangNextSend() {
      hangNext = true;
    },
  };
}
