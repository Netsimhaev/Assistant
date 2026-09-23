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
  /**
   * `businessId` is REQUIRED and has no default anywhere in this path.
   *
   * Everywhere else in this codebase the business is
   * `options.businessId ?? config.businessId`. Here that pattern is
   * forbidden: an omitted business would read silently as "the one in the
   * configuration", which is precisely the mechanism by which one customer
   * reads another's secret. Required means an omission is a compile error
   * rather than a wrong lookup at run time.
   */
  resolve(ref: string, businessId: string): Promise<CredentialHandle | null>;
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
 * non-empty. Exported so `ConnectionBinding` (`src/domain/connection.ts`) can
 * reject a malformed ref at configuration time — when a binding is written —
 * rather than let it read as credentialled and fail only at execution, with
 * nothing distinguishing "the ref is misspelled" from "the environment
 * variable is missing". This project rejects that class of thing at
 * configuration time everywhere else (an unresolvable timezone, an
 * uncompilable redaction pattern, a connection serving an unknown tool), and
 * a credential ref is no different.
 */
export const CREDENTIAL_REF_PATTERN = /^[A-Z0-9_]+$/;

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
 * - it does not match `CREDENTIAL_REF_PATTERN` (uppercase letters, digits, underscores
 *   only). A ref that differs from the canonical spelling only by case is
 *   not a legal ref at all, so it never reaches the environment lookup in
 *   the first place;
 * - the prefixed key is not present among the environment object's *own*
 *   enumerable keys, checked by an exact-string membership test
 *   (`Object.keys(env).includes(key)`), deliberately not `Object.hasOwn`.
 *   `Object.hasOwn(env, key)` is *not* reliably case-sensitive here —
 *   Node's `process.env` accessor is case-insensitive on Windows, so
 *   `Object.hasOwn(process.env, 'ASSISTANT_CREDENTIAL_OFFICE_MAIL')`
 *   returns `true` there even when the variable was actually set as
 *   `assistant_credential_office_mail`. `Object.keys(env)` always returns
 *   `process.env`'s keys in the exact casing they were set with, on every
 *   platform, so comparing against that list is what actually makes the
 *   ref-shape guard above mean something: without it, a differently-cased
 *   real variable would still resolve in Windows dev and return `null` in
 *   Linux production — the exact split CREDENTIAL_REF_PATTERN exists to rule out.
 *   Checking the *own* key list also rejects anything sitting on the
 *   environment object's prototype rather than on the object itself, which
 *   plain indexing (`env[key]`) would otherwise return;
 * - the prefixed key is present but resolves to an empty string (an empty
 *   secret would still be attempted against a real external system and
 *   fail there, while `null` stops the step before it reaches anything) or
 *   to a non-string value (an own property can hold any type; only a
 *   string is a usable secret).
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
    // `businessId` is accepted to satisfy `CredentialSource` but ignored:
    // this source exists for tests only, and reads from a single shared
    // process environment with no per-business partition. The real store
    // (a later task) is what actually keys a lookup by business.
    async resolve(ref: string, _businessId: string): Promise<CredentialHandle | null> {
      if (!CREDENTIAL_REF_PATTERN.test(ref)) return null;
      const key = prefix + ref;
      // Exact-string membership, not Object.hasOwn: see the docblock above
      // for why hasOwn is not safe to use for this on Windows.
      if (!Object.keys(env).includes(key)) return null;
      const value = env[key];
      if (typeof value !== 'string' || value.length === 0) return null;
      return createCredentialHandle(ref, value);
    },
  };
}
