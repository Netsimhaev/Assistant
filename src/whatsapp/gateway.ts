/**
 * The boundary between the orchestrator and whichever WhatsApp transport is
 * actually wired up — an unofficial multi-device bridge today, possibly the
 * official Meta Cloud API later. Nothing above this interface should need to
 * change when that swap happens; everything that would otherwise differ
 * between the two is named here, as a method, so a provider that behaves
 * differently just implements the method differently.
 */

/**
 * A message as the gateway hands it upward, already normalized out of
 * whatever shape the provider's webhook or poll response used.
 */
export interface NormalizedInboundMessage {
  providerMessageId: string;
  senderNumber: string;
  body: string | null;
  /** `null` for a plain text message. `'audio'` is the only kind Task 6 acts on. */
  mediaKind: string | null;
  /** Resolves the audio bytes. Present only when `mediaKind === 'audio'`. */
  downloadAudio?: () => Promise<{ bytes: Buffer; mimeType: string; seconds: number }>;
  providerTimestamp: string;
}

export type GatewayHealth =
  | { state: 'connected'; since: string }
  | { state: 'reconnecting' | 'qr_required' | 'throttled' | 'banned'; since: string; detail?: string };

export interface WhatsAppGateway {
  /**
   * Whether free text may be sent to this contact right now. Never assumes
   * true.
   *
   * This is "the detail that makes everything reversible" (08b §2). The
   * unofficial bridge this project runs today has no such restriction and
   * returns `true` unconditionally; the official Meta Cloud API returns
   * `false` once more than 24 hours have passed since the contact's last
   * inbound message, and a caller must fall back to a template message
   * instead. Putting the check on the interface — rather than letting every
   * caller assume the unofficial bridge's "always yes" — means that the day
   * this project moves to the official API, the swap is one file
   * (`gateway.ts`'s implementation) rather than an audit of every call site
   * that sends a message.
   */
  canSendFreeform(contactId: string): Promise<boolean>;
  sendMessage(input: {
    contactId: string; body: string; idempotencyKey: string;
  }): Promise<{ messageId: string; state: 'sent' | 'queued' | 'rejected' }>;
  health(): Promise<GatewayHealth>;
  /**
   * Registers the handler. Push and pull implementations both satisfy this.
   * Replaces any previous handler — fix round 1 (task 7), Minor 14: a caller
   * that registers on every pass (the door does, once per `runWhatsAppDoor`
   * call) must not accumulate one closure per pass against an
   * EventEmitter-backed implementation.
   */
  onInbound(handler: (msg: NormalizedInboundMessage) => Promise<void>): void;
  /**
   * Drains whatever is waiting and returns how many messages it delivered to
   * the registered handler.
   *
   * This exists on the interface for the same reason `canSendFreeform` does:
   * a webhook-based implementation receives pushes and can satisfy this
   * method as a no-op that always returns 0, while a polling implementation
   * does real work here. Either way, the choice between push and pull stays
   * inside the implementation and never leaks into the orchestrator code
   * that drives this interface.
   */
  pollOnce(): Promise<number>;
}
