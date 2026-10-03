/**
 * A double for the real `BossMessenger` that a later task builds.
 *
 * This is deliberately not the gateway double. `FakeGateway` (`./fake-gateway.js`)
 * records what the transport was *handed* — the raw `contactId`/`body`/
 * `idempotencyKey` triple `sendMessage` receives. Later tasks assert on what
 * the *assistant said*, which is a different surface one layer up: the text
 * `BossMessenger` composes and decides to send, addressed to no one in
 * particular because there is exactly one boss number. `sentTexts` is that
 * surface — just the text, in order, nothing about contacts or idempotency
 * keys because `BossMessenger` has already resolved those below this line.
 *
 * `send` never throws, under any circumstance, `failNext()` included — that
 * is the real `BossMessenger`'s contract (it must survive a transport
 * failure without taking the caller down with it), and a double that threw
 * here would let a later task's test pass against the fake while the real
 * implementation breaks the same case.
 */
export interface FakeMessenger {
  readonly channel: 'whatsapp';
  send(input: { text: string; jobId: string | null }): Promise<{ ok: boolean; error?: string }>;
  /** Everything the ASSISTANT said, in order — just the text. */
  readonly sentTexts: string[];
  /** Makes the next `send` return `{ ok: false }`. Never throws. */
  failNext(): void;
}

export function createFakeMessenger(): FakeMessenger {
  const sentTexts: string[] = [];
  let failNextCall = false;

  return {
    channel: 'whatsapp',

    async send(input) {
      if (failNextCall) {
        failNextCall = false;
        return { ok: false, error: 'fake-messenger: forced failure' };
      }
      sentTexts.push(input.text);
      return { ok: true };
    },

    sentTexts,

    failNext() {
      failNextCall = true;
    },
  };
}
