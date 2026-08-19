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
 * Every ref this source will look up is read under this prefix by default.
 * A `credential_ref` of `OFFICE_MAIL` therefore reads
 * `ASSISTANT_CREDENTIAL_OFFICE_MAIL`, never `OFFICE_MAIL` itself — so there
 * is no ref a binding can carry that reaches `DATABASE_URL`,
 * `ANTHROPIC_API_KEY`, or any other infrastructure variable that happens to
 * live in the same process environment. This is a positive control: the
 * namespace bindings can name is disjoint from the namespace infrastructure
 * uses, rather than a blocklist of names bindings must not use.
 */
export const DEFAULT_CREDENTIAL_ENV_PREFIX = 'ASSISTANT_CREDENTIAL_';

/**
 * Reads secrets from the process environment.
 *
 * `prefix` (default `DEFAULT_CREDENTIAL_ENV_PREFIX`) is prepended to every
 * ref before lookup — see that constant for why. It is overridable so tests
 * can use a short, readable prefix without touching the real one.
 *
 * A ref resolves to `null`, never a handle, when:
 * - the prefixed key is absent or holds an empty string (an empty secret
 *   would still be attempted against a real external system and fail there,
 *   while `null` stops the step before it reaches anything);
 * - the prefixed key is not the environment object's *own* property. Plain
 *   indexing (`env[key]`) also returns inherited properties such as
 *   `constructor`, `hasOwnProperty`, `toString` and `__proto__`, so a ref
 *   spelled that way would otherwise resolve to a Function or Object instead
 *   of `null`. `Object.hasOwn` rejects those, and rejects a resolved value
 *   that is not a string for the same reason.
 *
 * Lookup is case-sensitive by deliberate choice, not by accident of
 * platform: `process.env` is case-insensitive on Windows and case-sensitive
 * on Linux, so a ref that only matched by case would resolve in dev and
 * silently return `null` in production. `Object.hasOwn` is case-sensitive on
 * both, so refs behave identically everywhere this runs.
 *
 * Handles are built with `createCredentialHandle`, which is the only way to
 * produce a value typed `CredentialHandle` — it hides `value` from
 * `Object.keys` (and therefore `canonicalJson`) and from `JSON.stringify`
 * alike.
 */
export function envCredentials(
  env: Record<string, string | undefined> = process.env,
  prefix: string = DEFAULT_CREDENTIAL_ENV_PREFIX,
): CredentialSource {
  return {
    async resolve(ref: string): Promise<CredentialHandle | null> {
      const key = prefix + ref;
      if (!Object.hasOwn(env, key)) return null;
      const value = env[key];
      if (typeof value !== 'string' || value.length === 0) return null;
      return createCredentialHandle(ref, value);
    },
  };
}
