/**
 * Builds the provider-facing side of the OAuth consent ceremony: the
 * authorisation URL the owner's browser is redirected to, and the exchange
 * of an authorisation code for tokens once the provider redirects back.
 *
 * **This module never writes a grant, and never imports
 * `../governance/oauth-grants.js`.** It builds URLs and exchanges codes --
 * nothing here has a business writing the result of that exchange to
 * storage. `src/dashboard/oauth-routes.ts` owns that write, and a later
 * task's source scan pins the set of files that may import the grant store
 * to exactly `oauth-routes.ts` and `src/orchestrator/oauth-token.ts` (spec
 * invariant 3). Keeping the write out of here is what makes that scan mean
 * something.
 *
 * Google only, today. `google-calendar.ts` is the one provider adapter this
 * subproject wires, so `buildConsentUrl` refuses any `provider` other than
 * `'google'` rather than silently building a URL for a provider nothing
 * downstream can serve -- the same shape `googleTokenHttp`'s own
 * `SUPPORTED_PROVIDER` check takes for the identical reason (see that
 * module's docblock).
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  GOOGLE_CLIENT_ID_REF,
  GOOGLE_CLIENT_SECRET_REF,
} from '../orchestrator/adapters/google-token-http.js';
import {
  MICROSOFT_CLIENT_ID_REF,
  MICROSOFT_CLIENT_SECRET_REF,
} from '../orchestrator/adapters/microsoft-token-http.js';
import type { CredentialSource } from '../orchestrator/credentials.js';
import type { MailProvider } from '../mail/mailbox.js';
import { GOOGLE_TOKEN_URL } from './oauth-profiles.js';

/** The providers this ceremony talks to: Google (calendar, Gmail) and Microsoft (mailbox only). */
function isSupportedProvider(provider: string): provider is MailProvider {
  return provider === 'google' || provider === 'microsoft';
}

const MICROSOFT_ME_ENDPOINT = 'https://graph.microsoft.com/v1.0/me';

/**
 * Google's primary calendar resource, read with the SAME access token and
 * the SAME scope (`calendar.readonly`) the ceremony already requested --
 * never a wider one. Its `id` field, for the primary calendar, IS the
 * connected account's own address. This is what lets the ceremony record
 * `account` (spec 5.6, "לאיזה חשבון") without asking for `email` or
 * `profile` on top of the one scope spec 5.3 says to request -- widening the
 * scope just to print a label back to the owner would be exactly the
 * "narrowest scope" rule this ceremony exists to keep.
 */
const GOOGLE_PRIMARY_CALENDAR_ENDPOINT = 'https://www.googleapis.com/calendar/v3/calendars/primary';

/**
 * A PKCE code verifier: 32 random bytes, base64url-encoded -- 43 characters,
 * the RFC 7636 minimum, and every character already falls inside the
 * "unreserved" set the RFC requires (base64url's alphabet is a subset of
 * it), so no further escaping is needed.
 */
export function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** S256: base64url(sha256(verifier)) -- the one PKCE method this ceremony offers. */
export function codeChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface BuildConsentUrlInput {
  provider: string;
  /** From the per-system profile (`oauth-profiles.ts`). */
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
}

/**
 * The URL the owner's browser is redirected to. `state` and `code_challenge`
 * are opaque values the caller already produced (`oauth-state.ts`,
 * `codeChallengeFor` above); this function's only job is assembling them
 * into a well-formed request.
 *
 * `access_type=offline` and `prompt=consent` are both required, together:
 * without `offline`, Google mints only a short-lived access token and never
 * a refresh token; without `prompt=consent`, an account that already granted
 * this app access once (a re-consent after a revoke, most commonly) is
 * silently re-approved with NO refresh token in the response either, because
 * Google only issues one on a screen the owner actually saw and clicked
 * through. Either omission makes the flow LOOK successful and die within the
 * hour -- see spec 5.3.
 */
export function buildConsentUrl(input: BuildConsentUrlInput): string {
  if (!isSupportedProvider(input.provider)) {
    throw new Error(`buildConsentUrl: הספק "${input.provider}" אינו נתמך`);
  }
  const url = new URL(input.authorizeUrl);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', input.scopes.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.provider === 'google') {
    // Google-only: Microsoft gets its refresh token from the `offline_access` scope.
    url.searchParams.set('access_type', 'offline');
  } else {
    url.searchParams.set('response_mode', 'query');
  }
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export interface ExchangeCodeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  /** Resolves the APPLICATION's own client id/secret -- never the business's grant. Production: `storedCredentials(key)`. */
  credentials: CredentialSource;
  businessId: string;
  /** Defaults to `'google'`. Selects the client refs and, with `tokenUrl`, the endpoint. */
  provider?: MailProvider;
  /** From the per-system profile. Defaults to Google's. */
  tokenUrl?: string;
  /** Test seam only. No production caller ever passes it -- the same discipline `googleTokenHttp`'s `fetchImpl` keeps. */
  fetchImpl?: typeof fetch;
}

export type ExchangeCodeOutcome =
  | {
      ok: true;
      accessToken: string;
      /** `null` when the provider did not return one -- see `buildConsentUrl`'s docblock for when that happens even with `access_type=offline` requested. The caller must treat this as a failure to connect, not a partial success. */
      refreshToken: string | null;
      /** What the provider actually GRANTED, from its own `scope` field -- never what was requested. A provider may hand back fewer scopes than asked for; recording the request instead would be a lie about what the assistant can actually do. */
      grantedScopes: string[];
      /** Google OIDC `id_token` when `openid` was granted, else `null`. Used only to read the account's email. */
      idToken: string | null;
    }
  | { ok: false; kind: 'misconfigured' | 'rejected' | 'transient'; message: string };

/**
 * `expires_in` is deliberately NOT a field here. This grant's access token is
 * never kept past this one request (the caller reads it once, to fetch the
 * account label, and discards it -- `oauth-token.ts`'s own long-lived access
 * token cache is a separate, later concern), so an expiry nobody reads would
 * be dead data with a sharp edge: requiring it would turn a genuinely
 * successful exchange into a manufactured `transient` failure the moment a
 * provider ever omits it -- AFTER the one-use `state` has already been
 * consumed, so the owner would have to restart the whole ceremony over a
 * field this module never uses.
 */
const GoogleAuthCodeSuccessBody = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  id_token: z.string().min(1).optional(),
});

/**
 * The one-time exchange of an authorisation code for tokens -- distinct from
 * `TokenHttp.exchangeRefresh` (`orchestrator/oauth-token.ts`), which repeats
 * for the lifetime of the grant. This runs exactly once per consent.
 *
 * The three-way failure classification mirrors `googleTokenHttp`
 * (`orchestrator/adapters/google-token-http.ts`) for the identical reasons
 * stated there: `'misconfigured'` (the app's own client id/secret was never
 * provisioned -- Google was never reached) must not be confused with
 * `'rejected'` (Google looked at the code and refused it -- expired, reused,
 * or a PKCE mismatch) or `'transient'` (network trouble, or Google's own
 * 429/5xx). No token value, and no raw response body, ever reaches
 * `message` -- only the HTTP status and, where the provider supplies one,
 * its own short error CODE.
 */
export async function exchangeCode(input: ExchangeCodeInput): Promise<ExchangeCodeOutcome> {
  const doFetch = input.fetchImpl ?? fetch;

  const provider = input.provider ?? 'google';
  const names = provider === 'microsoft' ? 'Microsoft' : 'Google';
  const idRef = provider === 'microsoft' ? MICROSOFT_CLIENT_ID_REF : GOOGLE_CLIENT_ID_REF;
  const secretRef = provider === 'microsoft' ? MICROSOFT_CLIENT_SECRET_REF : GOOGLE_CLIENT_SECRET_REF;
  const tokenUrl = input.tokenUrl ?? GOOGLE_TOKEN_URL;
  const [clientId, clientSecret] = await Promise.all([
    input.credentials.resolve(idRef, input.businessId),
    input.credentials.resolve(secretRef, input.businessId),
  ]);
  if (clientId === null || clientSecret === null) {
    return {
      ok: false,
      kind: 'misconfigured',
      message: `תצורת ה-OAuth של ${names} חסרה — יש להקציב ${idRef} ו-${secretRef} במאגר הסודות`,
    };
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: clientId.value,
    client_secret: clientSecret.value,
    code_verifier: input.codeVerifier,
  });

  let response: Response;
  try {
    response = await doFetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (error) {
    return {
      ok: false,
      kind: 'transient',
      message: `כשל רשת בהחלפת קוד ההרשאה מול ${names}: ${errorText(error)}`,
    };
  }

  if (response.status >= 200 && response.status < 300) {
    const parsed = GoogleAuthCodeSuccessBody.safeParse(await readJson(response));
    if (!parsed.success) {
      return {
        ok: false,
        kind: 'transient',
        message: `${names} החזיר תשובה תקינה בסטטוס אך עם גוף שלא ניתן לפענח`,
      };
    }
    return {
      ok: true,
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? null,
      grantedScopes: (parsed.data.scope ?? '')
        .split(/\s+/)
        .filter((scope) => scope.length > 0),
      idToken: parsed.data.id_token ?? null,
    };
  }

  const errorCode = await readErrorCode(response);
  const suffix = errorCode === null ? '' : ` (${errorCode})`;

  if (response.status === 429 || response.status >= 500) {
    return {
      ok: false,
      kind: 'transient',
      message: `כשל זמני מול ${names} — סטטוס ${response.status}${suffix}`,
    };
  }

  return {
    ok: false,
    kind: 'rejected',
    message: `${names} דחה את קוד ההרשאה — סטטוס ${response.status}${suffix}`,
  };
}

/**
 * The connected account's own address, read from the primary calendar's
 * `id` field -- see the constant's own docblock for why this avoids
 * widening the scope just to label the account. `null` on ANY failure
 * (network, non-2xx, unparseable body, missing/empty `id`): this is a label
 * for a screen, not a fact the grant's validity depends on, so a failure
 * here must never block writing the grant itself.
 */
export async function fetchGoogleAccount(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_PRIMARY_CALENDAR_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return null;
  }
  if (response.status < 200 || response.status >= 300) return null;
  const body = await readJson(response);
  if (typeof body !== 'object' || body === null) return null;
  const id = (body as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** The provider's own short error CODE only (e.g. `invalid_grant`) -- never the raw body. See `exchangeCode`'s own docblock. */
async function readErrorCode(response: Response): Promise<string | null> {
  const raw = await readJson(response);
  if (typeof raw !== 'object' || raw === null) return null;
  const value = (raw as Record<string, unknown>)['error'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The account's email from a Google OIDC id-token (`openid email` scopes).
 * The token arrived directly from Google's token endpoint over TLS in the
 * same exchange, so its signature is not re-verified; it is read only as a
 * display label for the owner, never as a fact any decision depends on.
 * `null` on any malformed input.
 */
export function emailFromIdToken(idToken: string | null): string | null {
  if (idToken === null) return null;
  const part = idToken.split('.')[1];
  if (part === undefined) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (typeof claims !== 'object' || claims === null) return null;
    const email = (claims as Record<string, unknown>)['email'];
    return typeof email === 'string' && email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

/** The Microsoft account's address: Graph `/me` -> `mail ?? userPrincipalName`. `null` on any failure; a label only. */
export async function fetchMicrosoftAccount(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchImpl(MICROSOFT_ME_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch {
    return null;
  }
  if (response.status < 200 || response.status >= 300) return null;
  const body = await readJson(response);
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  for (const key of ['mail', 'userPrincipalName']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}
