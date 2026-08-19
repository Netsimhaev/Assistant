/**
 * An opaque secret. Adapters use it; nothing logs or serialises it.
 *
 * `toJSON` is declared here (rather than left for a caller to bolt on with a
 * cast) so a handle that hides its `value` under `JSON.stringify` is the
 * interface's own contract, not a workaround applied at the call site.
 */
export interface CredentialHandle {
  readonly ref: string;
  readonly value: string;
  readonly toJSON?: () => unknown;
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
