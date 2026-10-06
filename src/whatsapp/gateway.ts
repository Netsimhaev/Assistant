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
  /**
   * **Required form: leading `+`, international, digits only after
   * normalisation — e.g. `+972501234567`, never `972501234567` and never a
   * national form (`0501234567`).** This is the exact shape
   * `authorityNumberKey` (`src/governance/principal-number.ts`) accepts and
   * nothing else: `authorityNumberKey` rejects any value that does not
   * start with `+`, so a gateway that hands this up bare-digit will make
   * `isPrincipalSender` return `false` for every message the owner's own
   * number sends — his instructions filed as a stranger's, nothing ever
   * answered, no error anywhere to say why. This requirement was carried
   * as prose in a planning ledger and drifted from the code it described;
   * it is stated here, on the interface, so a future gateway implementer
   * reads it where the contract actually lives — see fix round A, finding 2.
   *
   * **Two further requirements, both from the security review that caught
   * the format drift:**
   * - Must be the individual participant who sent the message, never a
   *   group-chat id. `isPrincipalSender` compares this against one
   *   person's number; a group id compared the same way either never
   *   matches (safe but useless) or, if a provider ever reuses the shape,
   *   could let a group stand in for a person it is not.
   * - Must come from a message actually addressed to this assistant's own
   *   WhatsApp number, never a provider's echo of the owner's OWN outgoing
   *   messages (some providers surface a device's sent messages through
   *   the same inbound stream). An echoed outgoing message would carry the
   *   owner's own number as `senderNumber` by construction — indistinguishable
   *   from a genuine inbound message from him — and get replayed back at
   *   him as if he had just sent it.
   */
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
