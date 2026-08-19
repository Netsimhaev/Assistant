/**
 * An opaque secret. Adapters use it; nothing logs or serialises it.
 *
 * `toJSON` is declared here, and required rather than optional, so a handle
 * that hides its `value` under `JSON.stringify` is the interface's own
 * contract rather than a workaround a caller might forget to add. Optional
 * would let `{ ref, value }` typecheck and serialise the secret in full,
 * which is exactly the redaction this interface exists to guarantee.
 */
export interface CredentialHandle {
  readonly ref: string;
  readonly value: string;
  readonly toJSON: () => unknown;
}

export interface AdapterCall {
  toolName: string;
  /**
   * The REDACTED payload.
   *
   * `executeStep` hands `perform` the gate's `redactedInput`, so an adapter
   * cannot send what the agent proposed even by accident.
   */
  input: unknown;
  credential: CredentialHandle | null;
  /**
   * A key the caller generates once per attempt at the underlying business
   * action, stable across retries of that same attempt.
   *
   * A `retryable: true` result carries no `externalId` — the point of
   * retrying is that nothing was created yet, or the adapter cannot tell —
   * so without this key an ambiguous timeout on `purchase.place` retries into
   * a second, real order. An adapter must forward it to any external system
   * that accepts an idempotency key of its own; one that does not is not
   * protected by this field, only handed it.
   */
  idempotencyKey: string;
  signal: AbortSignal;
}

export type AdapterResult =
  | { ok: true; output: unknown; externalId: string | null }
  | { ok: false; retryable: boolean; code: string; message: string };

/**
 * One external system, as the orchestrator sees it.
 *
 * An adapter returns a result rather than throwing. An exception escaping an
 * adapter skips the outcome record and leaves an intent entry with no ending;
 * a returned value is something the caller can check.
 */
export interface ExternalAdapter {
  readonly system: string;
  readonly channel: 'api' | 'browser';
  readonly serves: readonly string[];
  execute(call: AdapterCall): Promise<AdapterResult>;
}
