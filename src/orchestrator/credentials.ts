import { createCredentialHandle } from './adapters/types.js';
import type { CredentialHandle } from './adapters/types.js';

/**
 * Where a `credential_ref` turns into an actual secret.
 *
 * An interface with a deliberately small surface: the full CredentialBroker
 * (subsystem 3) replaces the implementation without any adapter changing. The
 * secret never enters the model's context and never enters the audit log —
 * only the ref does.
 */
export interface CredentialSource {
  resolve(ref: string): Promise<CredentialHandle | null>;
}

/**
 * Reads secrets from the process environment.
 *
 * An absent or empty ref yields `null`, not a handle wrapping an empty
 * string: an empty secret would still be attempted against a real external
 * system and fail there, while `null` stops the step before it reaches
 * anything. Handles are built with `createCredentialHandle`, which is the
 * only way to produce a value typed `CredentialHandle` — it hides `value`
 * from `Object.keys` (and therefore `canonicalJson`) and from
 * `JSON.stringify` alike.
 */
export function envCredentials(
  env: Record<string, string | undefined> = process.env,
): CredentialSource {
  return {
    async resolve(ref: string): Promise<CredentialHandle | null> {
      const value = env[ref];
      if (value === undefined || value.length === 0) return null;
      return createCredentialHandle(ref, value);
    },
  };
}
