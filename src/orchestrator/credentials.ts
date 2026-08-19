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
 * A legal `credential_ref`: uppercase letters, digits and underscores only,
 * non-empty. This is what actually closes the case-sensitivity gap, not the
 * lookup mechanism — see `resolve` below.
 */
const REF_PATTERN = /^[A-Z0-9_]+$/;

/**
 * Reads secrets from the process environment.
 *
 * `prefix` (default `DEFAULT_CREDENTIAL_ENV_PREFIX`) is prepended to every
 * ref before lookup — see that constant for why. It is overridable so tests
 * can use a short, readable prefix without touching the real one, but an
 * empty or whitespace-only prefix is refused at construction: that value
 * would silently restore a bare `env[ref]` lookup and remove the namespace
 * separation entirely, so it must fail loudly here rather than pass every
 * namespace test while doing nothing.
 *
 * A ref resolves to `null`, never a handle, when:
 * - it does not match `REF_PATTERN` (uppercase letters, digits, underscores
 *   only). This is what makes case ambiguity impossible, not the lookup
 *   mechanism below: a ref that differs from the canonical spelling only by
 *   case is not a legal ref at all, so it never reaches the environment
 *   lookup in the first place. This matters because `Object.hasOwn` is
 *   *not* reliably case-sensitive here — Node's `process.env` accessor is
 *   case-insensitive on Windows, so `Object.hasOwn(process.env,
 *   'ASSISTANT_CREDENTIAL_office_mail')` can return `true` there even
 *   though the same lookup is case-sensitive on Linux. Relying on
 *   `Object.hasOwn`'s case sensitivity would make a ref resolve in dev on
 *   Windows and return `null` in production on Linux;
 * - the prefixed key is absent or holds an empty string (an empty secret
 *   would still be attempted against a real external system and fail there,
 *   while `null` stops the step before it reaches anything);
 * - the prefixed key is not the environment object's *own* property. Plain
 *   indexing (`env[key]`) also returns inherited properties — anything
 *   sitting on the object's prototype rather than on the object itself —
 *   so a prefixed key that only exists there would otherwise resolve to
 *   whatever that inherited value is instead of `null`. `Object.hasOwn`
 *   rejects those, and rejects a resolved value that is not a string for
 *   the same reason (an own property can hold any type; only a string is a
 *   usable secret).
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
  if (prefix.trim().length === 0) {
    // Not a resolve-time null: a caller that passes '' (e.g. an unset config
    // value defaulting to the empty string) intends to remove the control,
    // whether it knows that or not. This must fail construction, not silently
    // behave like a bare env[ref] lookup that happens to pass every test that
    // does not think to try it.
    throw new Error(
      'envCredentials: prefix must not be empty or whitespace-only — an empty ' +
        'prefix removes the namespace separation between credential refs and ' +
        'infrastructure environment variables',
    );
  }

  return {
    async resolve(ref: string): Promise<CredentialHandle | null> {
      if (!REF_PATTERN.test(ref)) return null;
      const key = prefix + ref;
      if (!Object.hasOwn(env, key)) return null;
      const value = env[key];
      if (typeof value !== 'string' || value.length === 0) return null;
      return createCredentialHandle(ref, value);
    },
  };
}
