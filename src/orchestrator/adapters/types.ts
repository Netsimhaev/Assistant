/**
 * Not exported. The only way to produce a value typed `[CREDENTIAL_HANDLE]:
 * true` is `createCredentialHandle` below, which asserts its way past the
 * missing property — nothing else in or outside this module can spell the
 * property name to build one by hand. This is a type-only brand: no runtime
 * object ever actually carries this symbol as a key.
 */
declare const CREDENTIAL_HANDLE: unique symbol;

/**
 * An opaque secret. Adapters use it; nothing logs or serialises it.
 *
 * `toJSON` is declared here, and required rather than optional, so a handle
 * that hides its `value` under `JSON.stringify` is the interface's own
 * contract rather than a workaround a caller might forget to add. Optional
 * would let `{ ref, value }` typecheck and serialise the secret in full,
 * which is exactly the redaction this interface exists to guarantee.
 *
 * `toJSON` alone is not enough: this project's own serialiser,
 * `canonicalJson` (`src/util/canonical.ts`), walks `Object.keys` directly and
 * never calls `toJSON` — three hashes (the charter signature, the audit
 * chain, the approval TOCTOU guard) depend on that serialiser's determinism,
 * so it is not changed to accommodate this. A credential handle built with a
 * plain object literal therefore still leaks `value` into any payload that
 * goes through `canonicalJson`, permanently, since `audit_log` is
 * append-only. `createCredentialHandle` below is the mitigation: it defines
 * `value` as a non-enumerable property, so `Object.keys` — and therefore
 * `canonicalJson` and `JSON.stringify` alike — does not see it, while an
 * adapter that needs the secret can still read `handle.value` directly.
 *
 * The `[CREDENTIAL_HANDLE]` field brands the type. Without it, `{ ref, value,
 * toJSON }` typechecks as a `CredentialHandle` with an ordinary, enumerable
 * `value` — a hand-built literal that compiles and leaks. With it, only
 * `createCredentialHandle`'s own cast can produce one, so the non-enumerable
 * construction above is enforced rather than merely conventional.
 */
export interface CredentialHandle {
  readonly ref: string;
  readonly value: string;
  readonly toJSON: () => unknown;
  readonly [CREDENTIAL_HANDLE]: true;
}

/**
 * Build a `CredentialHandle` whose `value` cannot be enumerated.
 *
 * Use this instead of an object literal wherever a real secret is involved.
 * `ref` stays a normal, enumerable property — it identifies the credential
 * without being the credential — so `canonicalJson({ credential: handle })`
 * serialises to `{"ref":"..."}` and never touches `value`.
 */
export function createCredentialHandle(ref: string, value: string): CredentialHandle {
  const handle = { ref } as { ref: string } & { value: string; toJSON: () => unknown };
  Object.defineProperty(handle, 'value', {
    value,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(handle, 'toJSON', {
    value: () => ({ ref }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  // The brand is asserted, never actually written: no runtime object holds
  // this key. This is the one place in the codebase allowed to claim the
  // brand, and every other call site is left with a type that a plain
  // literal cannot satisfy.
  //
  // The cast is the narrow `as CredentialHandle` rather than `as unknown as
  // CredentialHandle`, which buys exactly one thing and no more: the field
  // *types* stay checked against the interface, so if `CredentialHandle.ref`
  // became a number while `handle`'s declared type still said string, this
  // line would stop compiling.
  //
  // It does NOT check that the `defineProperty` calls above actually ran or
  // ran correctly. `handle`'s type comes from its own assertion on the line
  // that declares it, so TypeScript takes `value` and `toJSON` on faith and
  // never looks at the statements in between — deleting a whole
  // `defineProperty` block leaves `tsc --noEmit` silent. Nothing in the type
  // system can see enumerability at all.
  //
  // The only thing that proves the secret is actually hidden is the runtime
  // test in `adapters.test.ts` ('keeps the secret out of canonicalJson'). It
  // is not belt-and-braces alongside the cast; it is the sole guard. Deleting
  // it as redundant would leave the leak this factory exists to prevent with
  // no check at all.
  return handle as CredentialHandle;
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
   * `ConnectionBinding.endpoint` for the resolved system, or `null` when the
   * binding names none and the adapter should use its own default.
   *
   * Required rather than optional. The field was validated on write and
   * audited as a trust-relocating change — an endpoint points a permitted
   * connection at a different host — and then read by nobody at execution,
   * which made that audit entry a claim the code did not honour. Optional
   * would let an adapter be written without ever noticing the field exists;
   * required makes ignoring it a decision someone had to type.
   */
  endpoint: string | null;
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
