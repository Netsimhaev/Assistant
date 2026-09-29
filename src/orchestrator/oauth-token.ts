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
 * able to leak an access token into each other.
 *
 * **Ambiguity is a refusal, not a choice.** `resolveChannel` already treats
 * two channel matches at one level as a rejection rather than "the first one
 * in the array wins" — the same rule applies here: a ref that exists as BOTH
 * a stored grant and a static secret throws `AmbiguousCredentialRefError`
 * rather than silently preferring one. The check only runs when this module
 * is about to mint or refresh a token (a cache miss) — a cache hit already
 * proved, on an earlier call, that no conflicting secret exists for this ref,
 * and re-checking on every call would mean paying for a lookup against the
 * fallback source on every single credential resolution.
 *
 * **A fallback that throws is treated exactly like a fallback that returns
 * `null`.** `CredentialSource.resolve` is specified to return
 * `Promise<CredentialHandle | null>` — nothing in that contract says it may
 * throw for an ordinary miss, and every real implementation in this codebase
 * (`envCredentials`, `storedCredentials`) never does. A fallback that throws
 * anyway has nothing to contribute to this ref: it must not be able to break
 * resolution of an OAuth-backed credential the grant store has already
 * produced (or, symmetrically, block the plain non-OAuth path when no grant
 * exists at all). This is also what makes the ref genuinely provable in
 * tests: a `CredentialSource` double whose `resolve` throws proves the
 * fallback was never actually relied on for its answer, because relying on
 * it (a real `!== null` result) is the only thing this module treats as
 * meaningful.
 *
 * Retrying a refresh after a transient failure, or retrying the tool call
 * itself after a 401, is deliberately NOT this module's job — that decision
 * belongs to the adapter that calls `resolve` (a later task), because only
 * the adapter knows whether the tool it is about to call is read-only.
 */
import { appendAudit } from '../audit/log.js';
import {
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
 * provider must be drivable by a test without one.
 */
export interface TokenHttp {
  exchangeRefresh(input: {
    provider: string;
    refreshToken: string;
    signal: AbortSignal;
  }): Promise<RefreshOutcome>;
}

export type RefreshOutcome =
  | { ok: true; accessToken: string; expiresInSeconds: number; rotatedRefreshToken: string | null }
  | { ok: false; kind: 'rejected' | 'transient'; message: string };

/** A `credential_ref` resolves through both a stored grant and a static secret. */
export class AmbiguousCredentialRefError extends Error {}
/** The provider refused the refresh token outright. Terminal — re-consent is required. */
export class OAuthRefreshRejectedError extends Error {}
/** The refresh attempt failed in a way that may succeed if tried again. Retryable. */
export class OAuthRefreshTransientError extends Error {}

/**
 * An access token is treated as expired this many milliseconds before the
 * provider's own deadline. The exchange itself, plus whatever the caller
 * does immediately after getting the handle back, takes real time — a token
 * with one second of nominal life left is not usable for anything.
 */
const SKEW_MS = 60_000;

/** How long a single token-exchange HTTP call may run before it is abandoned. */
const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

function cacheKey(businessId: string, system: string): string {
  return `${businessId}\u0000${system}`;
}

/**
 * Call a fallback `CredentialSource` and treat any exception it throws the
 * same as its documented `null` result — see the module docblock for why.
 */
async function safeFallbackResolve(
  source: CredentialSource,
  ref: string,
  businessId: string,
): Promise<CredentialHandle | null> {
  try {
    return await source.resolve(ref, businessId);
  } catch {
    return null;
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
 * here to name a version for), and `reason` is built from the system and
 * the provider only — never the refresh token, never the provider's raw
 * response body.
 */
async function auditRefreshRejection(params: {
  businessId: string;
  system: string;
  provider: string;
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
        `על ידי הספק — נדרשת הרשאה מחדש`,
    },
    { businessId: params.businessId },
  );
}

/**
 * Build a `CredentialSource` that resolves an OAuth-backed ref to a live
 * access token, falling through to `options.fallback` for any ref that is
 * not a stored grant. See the module docblock for the caching, ambiguity and
 * fallback-error rules this composes.
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
      const grant = await readGrantByRef(ref, businessId, options.key);

      if (grant === null) {
        // Not a grant at all, or a grant that was just revoked -- either
        // way, this ref is not this module's to answer for. A fallback
        // that throws here is treated as "nothing to offer", same as null.
        return safeFallbackResolve(options.fallback, ref, businessId);
      }

      const key = cacheKey(businessId, grant.system);
      const cached = cache.get(key);
      if (cached !== undefined && cached.expiresAtMs > nowMs() + SKEW_MS) {
        return createCredentialHandle(ref, cached.accessToken);
      }

      // Cache miss: about to mint or refresh a real token for this ref, so
      // this is the moment an ambiguous configuration actually matters.
      const conflicting = await safeFallbackResolve(options.fallback, ref, businessId);
      if (conflicting !== null) {
        throw new AmbiguousCredentialRefError(
          `ההפניה "${ref}" קיימת גם כסוד וגם כהרשאת OAuth — יש להסיר אחת מהן`,
        );
      }

      const outcome = await options.http.exchangeRefresh({
        provider: grant.provider,
        refreshToken: grant.refreshToken,
        signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
      });

      if (!outcome.ok && outcome.kind === 'rejected') {
        await markNeedsReauth(grant.system, businessId);
        cache.delete(key);
        await auditRefreshRejection({
          businessId,
          system: grant.system,
          provider: grant.provider,
        });
        throw new OAuthRefreshRejectedError(
          `הספק (${grant.provider}) דחה את ריענון ההרשאה למערכת "${grant.system}" — נדרשת הרשאה מחדש`,
        );
      }
      if (!outcome.ok) {
        throw new OAuthRefreshTransientError(
          `כשל זמני בריענון ההרשאה למערכת "${grant.system}" מול הספק (${grant.provider})`,
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

/**
 * The real `TokenHttp`: calls the provider's own token endpoint over HTTPS.
 * Referenced by a later task (the adapter that wires `oauthCredentials` into
 * `buildRuntime`) and by a live-run script — never by this module's own
 * tests, which inject a stub so no test ever reaches the network. Endpoint
 * and client credentials are read per-provider from the environment at call
 * time (`OAUTH_TOKEN_ENDPOINT_<PROVIDER>`, `OAUTH_CLIENT_ID_<PROVIDER>`,
 * `OAUTH_CLIENT_SECRET_<PROVIDER>`, provider upper-cased) rather than once at
 * construction, so a credential rotated in the environment takes effect on
 * the next call without a process restart — the same reasoning
 * `createEmailNotifier` already applies to `NOTIFY_CREDENTIAL_REF`.
 *
 * Kept deliberately small: this is the seam, not the connector. It has the
 * same shape as `TokenHttp` and nothing more.
 */
export function defaultTokenHttp(): TokenHttp {
  return {
    async exchangeRefresh({ provider, refreshToken, signal }): Promise<RefreshOutcome> {
      const key = provider.toUpperCase();
      const endpoint = process.env[`OAUTH_TOKEN_ENDPOINT_${key}`];
      const clientId = process.env[`OAUTH_CLIENT_ID_${key}`];
      const clientSecret = process.env[`OAUTH_CLIENT_SECRET_${key}`];
      if (endpoint === undefined || clientId === undefined || clientSecret === undefined) {
        return {
          ok: false,
          kind: 'transient',
          message: `אין תצורת OAuth (endpoint/client) מוגדרת עבור הספק "${provider}"`,
        };
      }

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
          }),
          signal,
        });
      } catch {
        return { ok: false, kind: 'transient', message: 'שגיאת רשת בפנייה לספק ה-OAuth' };
      }

      if (response.status === 400 || response.status === 401) {
        return { ok: false, kind: 'rejected', message: `הספק דחה את הרענון (HTTP ${response.status})` };
      }
      if (!response.ok) {
        return { ok: false, kind: 'transient', message: `הספק החזיר שגיאה זמנית (HTTP ${response.status})` };
      }

      const body: unknown = await response.json().catch(() => null);
      const accessToken =
        body !== null && typeof body === 'object' && 'access_token' in body
          ? (body as { access_token: unknown }).access_token
          : undefined;
      const expiresIn =
        body !== null && typeof body === 'object' && 'expires_in' in body
          ? (body as { expires_in: unknown }).expires_in
          : undefined;
      const rotated =
        body !== null && typeof body === 'object' && 'refresh_token' in body
          ? (body as { refresh_token: unknown }).refresh_token
          : undefined;

      if (typeof accessToken !== 'string' || typeof expiresIn !== 'number') {
        return { ok: false, kind: 'transient', message: 'תגובת הספק חסרה שדות נדרשים' };
      }
      return {
        ok: true,
        accessToken,
        expiresInSeconds: expiresIn,
        rotatedRefreshToken: typeof rotated === 'string' ? rotated : null,
      };
    },
  };
}
