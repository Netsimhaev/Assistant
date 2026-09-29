/**
 * Turns a stored OAuth grant into a live access token, behind the same
 * `CredentialSource` interface every other credential resolver already
 * implements — see that interface's own docblock (`./credentials.ts`) for why
 * `businessId` is mandatory there with no default. This module never imports
 * `config`: every business it ever touches arrives as an explicit argument
 * from its caller, so the forbidden `options.businessId ?? config.businessId`
 * pattern is unreachable here, not merely unused.
 *
 * `oauthCredentials` COMPOSES over an existing `CredentialSource` (the
 * `fallback`) rather than replacing it. An earlier design gave adapters a
 * second method, `resolveAccessToken(system, businessId)`, which would have
 * added a field to `AdapterCall` and touched every adapter and the one call
 * site in `run-plan.ts` that already resolves a credential by the ref the
 * binding names. That was rejected: nothing downstream has to change when a
 * ref turns out to be OAuth-backed instead of a static secret, because both
 * kinds answer the exact same question through the exact same method.
 *
 * **The access token cache is a declared exception to an existing rule, not
 * an omission of it.** `createSmtpTransport` (`src/mail/transport.ts`)
 * resolves a credential fresh on every send and never keeps one in a module
 * variable that outlives a single send — the rule this project otherwise
 * always applies to secrets. This module keeps a short-lived access token in
 * memory anyway, because minting one is a real network round trip to the
 * provider and every adapter call would otherwise pay for it. Three things
 * make that safe:
 *   1. The REFRESH token — the actual long-lived secret — is never cached.
 *      Only the short-lived access token that `TokenHttp` hands back is kept,
 *      and only for as long as the provider says it is valid.
 *   2. `readGrantByRef` runs on EVERY call, cache hit or miss. It already
 *      refuses a revoked grant by returning `null` (its own docblock), so a
 *      revocation takes effect on the very next resolve — not "whenever the
 *      cached token happens to expire".
 *   3. The cache is cleared the moment an authentication failure is
 *      observed (a rejected refresh), so a stale entry never survives past
 *      the failure that proved it should not be trusted.
 * The cache lives in the closure of `oauthCredentials` (a plain `Map`
 * captured by the returned object), never as a module-level variable: two
 * instances — two tests, or a real one alongside a test double — must not be
 * able to leak an access token into each other. `cacheKey` folds `businessId`
 * into the key itself for the same reason: two businesses holding a grant
 * under the same `system` name must never be able to read each other's
 * access token out of one shared entry.
 *
 * **Ambiguity is a refusal, not a choice.** `resolveChannel` already treats
 * two channel matches at one level as a rejection rather than "the first one
 * in the array wins" — the same rule applies here: a ref that exists as BOTH
 * a stored grant and a static secret throws `AmbiguousCredentialRefError`
 * rather than silently preferring one. The check only runs when this module
 * is about to mint or refresh a token (a cache miss) — a cache hit already
 * proved, on an earlier call, that no conflicting secret exists for this ref,
 * and does not re-prove it now: re-checking on every call would mean paying
 * for a lookup against the fallback source on every single credential
 * resolution.
 *
 * **A revoked grant refuses; it does not fall through.** `readGrantByRef`
 * filters `revoked_at IS NULL` in SQL, so "there was never a grant" and
 * "there was one and the owner revoked it" both come back as `null` and are
 * indistinguishable from that call alone. Falling through to the fallback in
 * both cases would mean a ref configured as both a grant and a secret
 * refuses loudly while the grant is live (the ambiguity check above) and
 * then silently starts serving the static secret the instant the owner
 * revokes — the exact hazard the ambiguity check exists to name, reappearing
 * through the one door it does not watch. `grantStatusByRef`
 * (`../governance/oauth-grants.js`) takes no key — it is structurally
 * incapable of returning a token — and is consulted ONLY when `readGrantByRef`
 * already returned `null`, so the common "never a grant, fall through" path
 * pays for exactly one query, not two. `'revoked'` throws
 * `OAuthGrantRevokedError` (terminal); `'none'` falls through, and so does
 * `'live'` in the vanishingly rare case where the row is not revoked but
 * still failed to decrypt (a wrong master key) — `readGrantByRef`'s own
 * docblock already treats that as a configuration fact, not a crash, and
 * this module matches that rather than inventing a second opinion about it.
 *
 * **A fallback that throws propagates, in full, to this module's caller.**
 * `CredentialSource.resolve` is specified to return
 * `Promise<CredentialHandle | null>`, and every real implementation in this
 * codebase (`envCredentials`, `storedCredentials`) can, in fact, reject —
 * `storedCredentials` awaits a pooled `db.query`, and `notify.ts` carries a
 * docblock written specifically to retract the earlier, wrong claim that a
 * credential read has no such failure mode. An earlier version of this
 * module caught and swallowed a throwing fallback, treating it as `null`; a
 * database blip during the fall-through path would then have been
 * misreported to `run-plan.ts` as `credential_unavailable` — a code its own
 * comment there defines as "a misconfiguration; waiting five minutes does not
 * provision it" — turning a five-second blip into a terminal failure for
 * every credential in the installation once this source is wired into
 * `buildRuntime`. `resolve` here is therefore contractually allowed to
 * throw — a caller that wants a `{ ok: false }` shape instead of an
 * exception already has to handle that for every OTHER `CredentialSource`
 * too, and this one is no different. (It throws four of its own error
 * classes already, on top of whatever the fallback or the grant store can
 * raise.)
 *
 * **The refresh's time budget is enforced by a race, not by `AbortSignal`
 * alone.** A signal is advisory: nothing forces a component to check it, so
 * a library — or a test double — that ignores `context.signal` entirely
 * leaves the caller waiting forever. `callWithDeadline`
 * (`src/orchestrator/run-plan.ts`) and `withDeadline`
 * (`src/governance/notify.ts`) are the two existing precedents for this, and
 * `withOAuthDeadline` below is the same fix a third time, not a new idea:
 * both the governance read (`readGrantByRef` / `grantStatusByRef`) and the
 * token exchange (`TokenHttp.exchangeRefresh`) are raced against
 * `TOKEN_EXCHANGE_TIMEOUT_MS`. This sits BESIDE the step's own deadline
 * (`ADAPTER_TIMEOUT_MS` in `run-plan.ts`) rather than inside it: `performStep`
 * resolves the credential at one line and only opens its own
 * `callWithDeadline` afterwards, so a credential resolution that hung would
 * not otherwise be bounded by anything until the adapter call after it —
 * and moving credential resolution inside that later deadline would mean
 * editing `run-plan.ts`, which this sub-project does not touch.
 *
 * Retrying the refresh after a transient failure, or retrying the tool call
 * itself after a 401, is deliberately NOT this module's job — that decision
 * belongs to the adapter that calls `resolve` (a later task), because only
 * the adapter knows whether the tool it is about to call is read-only.
 */
import { appendAudit } from '../audit/log.js';
import {
  grantStatusByRef,
  markNeedsReauth,
  readGrantByRef,
  recordRefresh,
} from '../governance/oauth-grants.js';
import { canonicalHash } from '../util/canonical.js';
import { createCredentialHandle } from './adapters/types.js';
import type { CredentialHandle } from './adapters/types.js';
import type { CredentialSource } from './credentials.js';

/**
 * The one network call this module makes. Injectable for the same reason
 * `createSmtpTransport`'s factory is: the step that costs money and needs a
 * provider must be drivable by a test without one. The real implementation
 * belongs to the task that wires a specific provider in (it resolves the
 * client secret through the existing secret store, never `process.env` —
 * see `master-key.ts` for why a secret never lives in the environment).
 *
 * `businessId` is threaded through the input rather than captured by a
 * concrete `TokenHttp` at construction — see this module's own docblock on
 * why `businessId` is mandatory everywhere on this path with no default.
 * `oauthCredentials.resolve` already receives the caller's business; a
 * concrete implementation that instead bakes one in at construction (an
 * options field, a closure variable) reintroduces exactly the "whose
 * business is this really for" ambiguity this interface exists to make
 * unreachable — a refresh for business B would resolve B's grant against
 * business A's client secret. (Task 4's fix-round 1, finding I6: an earlier
 * `googleTokenHttp` did exactly this, harmlessly in a one-business-per-
 * install product, but the docblock claiming the pattern unreachable would
 * have been a lie.)
 *
 * A future `TokenHttp`'s `message` on any failure branch of `RefreshOutcome`
 * must be built from HTTP status codes and the provider's own error *codes*
 * (e.g. `invalid_grant`), never from the raw response body: a provider that
 * echoes request content back in an error body would otherwise let that
 * content reach whatever reads `message` — the audit row and the thrown
 * error's own text.
 *
 * **Three failure kinds, not two, and they are not interchangeable.**
 * - `'rejected'`: the PROVIDER looked at the refresh token itself and said
 *   no (`invalid_grant` and the like). Terminal, and specifically means
 *   "the owner must re-consent" — `oauthCredentials` writes an audit row
 *   naming the provider and calls `markNeedsReauth` on this branch.
 * - `'misconfigured'`: this INSTALLATION never provisioned what the
 *   implementation needs to even attempt the call (an app client id/secret
 *   never `secret put`, most likely) — the provider was never reached and
 *   said nothing. Terminal for the same reason a config error never
 *   self-heals on a retry, but it is not a claim about the grant or the
 *   provider, so it must not produce a provider-rejection audit row or
 *   flag the grant for re-consent: re-consenting cannot fix a missing
 *   local secret, and the false audit row would misdescribe what happened.
 * - `'transient'`: the attempt may succeed if tried again (network trouble,
 *   the provider's own 5xx/429). Retryable.
 *
 * Conflating `'misconfigured'` into `'rejected'` (Task 4's original mistake,
 * fix-round 1 finding I2) tells the owner "Google revoked your
 * authorisation" for an install that simply never ran `secret put`.
 */
export interface TokenHttp {
  exchangeRefresh(input: {
    provider: string;
    refreshToken: string;
    businessId: string;
    signal: AbortSignal;
  }): Promise<RefreshOutcome>;
}

export type RefreshOutcome =
  | { ok: true; accessToken: string; expiresInSeconds: number; rotatedRefreshToken: string | null }
  | { ok: false; kind: 'rejected' | 'misconfigured' | 'transient'; message: string };

/** A `credential_ref` resolves through both a stored grant and a static secret. */
export class AmbiguousCredentialRefError extends Error {}
/** The provider refused the refresh token outright. Terminal — re-consent is required. */
export class OAuthRefreshRejectedError extends Error {}
/**
 * This installation never provisioned what the `TokenHttp` implementation
 * needs (an app client id/secret, most likely) — the provider was never
 * reached. Terminal, like a rejection, but deliberately a DIFFERENT class:
 * `oauth-token.ts`'s docblock on `TokenHttp` states why conflating the two
 * is a real defect, not a simplification.
 */
export class OAuthMisconfiguredError extends Error {}
/** The refresh attempt failed in a way that may succeed if tried again. Retryable. */
export class OAuthRefreshTransientError extends Error {}
/** The owner revoked this grant. Terminal — never a silent handoff to a static secret. */
export class OAuthGrantRevokedError extends Error {}

/**
 * An access token is treated as expired this many milliseconds before the
 * provider's own deadline. The exchange itself, plus whatever the caller
 * does immediately after getting the handle back, takes real time — a token
 * with one second of nominal life left is not usable for anything.
 */
const SKEW_MS = 60_000;

/**
 * How long a single governance read or token-exchange call may run before it
 * is abandoned. One constant for both: it bounds the whole credential-
 * resolution phase `performStep` pays for before its own, separate adapter
 * deadline even starts — see the module docblock's race section.
 */
const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

function cacheKey(businessId: string, system: string): string {
  return `${businessId}\u0000${system}`;
}

/**
 * Bound a promise this module cannot otherwise guarantee will ever settle.
 * Mirrors `callWithDeadline` (`src/orchestrator/run-plan.ts`) and
 * `withDeadline` (`src/governance/notify.ts`) — same fix, third call site:
 * an `AbortSignal` handed alongside the promise is advisory only, and a
 * component (or a test double) that ignores it leaves the race as the only
 * thing that actually bounds the wait.
 */
async function withOAuthDeadline<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new OAuthRefreshTransientError(
            `${what} לא הסתיימה תוך ${TOKEN_EXCHANGE_TIMEOUT_MS} מ״ש`,
          ),
        ),
      TOKEN_EXCHANGE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Write the one audit row spec §2.5 assigns to this module: a refresh the
 * provider rejected. The other two cases §2.5 names belong to the consent
 * ceremony (Task 5), not here, and a SUCCESSFUL refresh is not audited at
 * all — it happens on essentially every adapter call, and a row per refresh
 * would bury the signal the way a row per credential resolve already does
 * not exist in `secret.ts`'s own accounting.
 *
 * Modelled on `auditAction` in `src/cli/secret.ts`: `actor: 'orchestrator'`
 * because no human is in this loop, `charterVersion: 'n/a'` because this
 * sits beside the gate rather than behind it (there is no charter decision
 * here to name a version for), and `reason` is built from the system, the
 * provider and the provider's own failure message only — never the refresh
 * token, never the provider's raw response body (see `TokenHttp`'s docblock
 * for why `message` itself must already be clean of that).
 */
async function auditRefreshRejection(params: {
  businessId: string;
  system: string;
  provider: string;
  message: string;
}): Promise<void> {
  await appendAudit(
    {
      actor: 'orchestrator',
      provenance: 'boss',
      kind: 'credential_change',
      charterVersion: 'n/a',
      inputHash: canonicalHash({
        businessId: params.businessId,
        system: params.system,
        provider: params.provider,
      }),
      reason:
        `ריענון ההרשאה למערכת "${params.system}" (ספק: ${params.provider}) נדחה ` +
        `על ידי הספק — נדרשת הרשאה מחדש (${params.message})`,
    },
    { businessId: params.businessId },
  );
}

/**
 * Build a `CredentialSource` that resolves an OAuth-backed ref to a live
 * access token, falling through to `options.fallback` for any ref that is
 * not a stored grant. See the module docblock for the caching, ambiguity,
 * revocation and deadline rules this composes.
 */
export function oauthCredentials(options: {
  key: Buffer;
  fallback: CredentialSource;
  http: TokenHttp;
  now?: () => number;
}): CredentialSource {
  const nowMs = options.now ?? (() => Date.now());
  // Closure-scoped, deliberately not a module-level variable: two instances
  // of this source — two tests, or a live one next to a test double — must
  // never be able to leak an access token into each other.
  const cache = new Map<string, CachedToken>();

  return {
    async resolve(ref: string, businessId: string): Promise<CredentialHandle | null> {
      // The governance read happens on EVERY call, cache hit or miss. This
      // is what makes revocation take effect on the next call rather than
      // merely "once the cached token's own lifetime runs out".
      const grant = await withOAuthDeadline(
        readGrantByRef(ref, businessId, options.key),
        'קריאת ההרשאה',
      );

      if (grant === null) {
        // `readGrantByRef` cannot tell "never a grant" from "a revoked one"
        // -- both return null. `grantStatusByRef` can, without ever touching
        // the master key, and is worth the extra query only here, on the
        // already-uncommon null path.
        const status = await withOAuthDeadline(
          grantStatusByRef(ref, businessId),
          'בדיקת מצב ההרשאה',
        );
        if (status === 'revoked') {
          throw new OAuthGrantRevokedError(
            `ההרשאה עבור ההפניה "${ref}" בוטלה על ידי הבעלים — לא ניתן להשתמש בה עוד`,
          );
        }
        // 'none' (the ordinary case), or 'live' with a decrypt failure under
        // a wrong master key -- both fall through, matching how
        // `readGrantByRef` itself treats a wrong key as a configuration
        // fact rather than a crash. Let a rejection from `fallback.resolve`
        // propagate as-is -- see the module docblock's C1 section.
        return options.fallback.resolve(ref, businessId);
      }

      const key = cacheKey(businessId, grant.system);
      const cached = cache.get(key);
      if (cached !== undefined && cached.expiresAtMs > nowMs() + SKEW_MS) {
        return createCredentialHandle(ref, cached.accessToken);
      }

      // Cache miss: about to mint or refresh a real token for this ref, so
      // this is the moment an ambiguous configuration actually matters. A
      // rejection here propagates as-is, same reasoning as above.
      const conflicting = await options.fallback.resolve(ref, businessId);
      if (conflicting !== null) {
        throw new AmbiguousCredentialRefError(
          `ההפניה "${ref}" קיימת גם כסוד וגם כהרשאת OAuth — יש להסיר אחת מהן`,
        );
      }

      const outcome = await withOAuthDeadline(
        options.http.exchangeRefresh({
          provider: grant.provider,
          refreshToken: grant.refreshToken,
          businessId,
          signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
        }),
        'ריענון ההרשאה',
      );

      if (!outcome.ok && outcome.kind === 'rejected') {
        // Clear the cache and write the audit row BEFORE calling
        // `markNeedsReauth`: that call throws when no live row matched (the
        // owner revoked concurrently), and a throw there must not be able to
        // skip recording a rejection that genuinely already happened.
        cache.delete(key);
        await auditRefreshRejection({
          businessId,
          system: grant.system,
          provider: grant.provider,
          message: outcome.message,
        });
        await markNeedsReauth(grant.system, businessId);
        throw new OAuthRefreshRejectedError(
          `הספק (${grant.provider}) דחה את ריענון ההרשאה למערכת "${grant.system}" — ` +
            `נדרשת הרשאה מחדש (${outcome.message})`,
        );
      }
      if (!outcome.ok && outcome.kind === 'misconfigured') {
        // Deliberately NEITHER the audit row NOR `markNeedsReauth` above:
        // the provider was never reached, so there is nothing to say about
        // it, and re-consenting cannot fix a local secret nobody
        // provisioned. See `TokenHttp`'s own docblock for the full ruling
        // (fix-round 1, finding I2).
        throw new OAuthMisconfiguredError(
          `תצורת ההתקנה למערכת "${grant.system}" (ספק: ${grant.provider}) חסרה — ` +
            `${outcome.message}`,
        );
      }
      if (!outcome.ok) {
        throw new OAuthRefreshTransientError(
          `כשל זמני בריענון ההרשאה למערכת "${grant.system}" מול הספק (${grant.provider}): ${outcome.message}`,
        );
      }

      await recordRefresh(grant.system, businessId, outcome.rotatedRefreshToken, options.key);
      cache.set(key, {
        accessToken: outcome.accessToken,
        expiresAtMs: nowMs() + outcome.expiresInSeconds * 1000,
      });
      return createCredentialHandle(ref, outcome.accessToken);
    },
  };
}
