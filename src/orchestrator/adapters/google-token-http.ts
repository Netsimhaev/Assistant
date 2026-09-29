/**
 * The real `TokenHttp` for Google: turns a stored refresh token into a live
 * access token by calling Google's own OAuth token endpoint.
 *
 * This is the piece that moved here from Task 3, in a deliberate reversal.
 * An earlier version of `oauth-token.ts` shipped a `defaultTokenHttp` that
 * read the OAuth client secret from `process.env` -- in a branch whose
 * entire purpose is getting secrets OUT of the environment. It was removed.
 * **The client credentials are resolved through the existing encrypted
 * store** (`storedCredentials`, `src/governance/credential-store.ts`), the
 * same path every other per-business secret in this project already
 * travels, never through `process.env` -- see `master-key.ts`'s own
 * reasoning for why a secret never lives there, and the removal of the SMTP
 * password's env variable (`runtime.ts`) on the identical argument.
 *
 * `googleTokenHttp` takes the credential SOURCE, not a resolved value, and
 * resolves both refs fresh on EVERY refresh call -- never once at
 * construction. That is what makes a rotated app secret (`secret put
 * GOOGLE_OAUTH_CLIENT_SECRET`, the CLI's only writer) take effect on the
 * very next token refresh with no process restart, the same property
 * `createEmailNotifier` already has for `NOTIFY_CREDENTIAL_REF`.
 *
 * **Missing configuration is a TERMINAL failure, not a transient one.** A
 * business that never provisioned the client id/secret refs gets `kind:
 * 'rejected'` here, never `'transient'` -- classifying a configuration
 * error as transient sends `oauthCredentials`' caller, and ultimately the
 * scheduler, back to retry the exact same missing configuration every five
 * minutes forever. A `CredentialSource.resolve` that THROWS (a database
 * blip resolving the client secret, not an absent one) is a different
 * failure mode and is deliberately left to propagate uncaught: catching it
 * and reporting `'rejected'` would send a perfectly live grant into
 * needs-reauth over a transient store failure that has nothing to do with
 * the grant itself. `oauthCredentials`'s own docblock states the same rule
 * for its `fallback` for the same reason.
 *
 * **No token value -- access token, refresh token, or client secret --
 * ever reaches a `RefreshOutcome.message`.** A failure message is built
 * from the HTTP status code and, where the provider supplies one, its own
 * short error CODE (`invalid_grant`, ...) -- never the raw response body,
 * which on some providers echoes request content back. This is the same
 * rule `TokenHttp`'s own docblock in `oauth-token.ts` states for whoever
 * builds the real implementation, and the same one `classifyTransportFailure`
 * in `adapters/mail.ts` already applies to an SMTP failure's `message`.
 */
import { z } from 'zod';
import type { CredentialSource } from '../credentials.js';
import type { RefreshOutcome, TokenHttp } from '../oauth-token.js';

/** Google's own token endpoint. Overridable only for tests. */
const DEFAULT_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * The refs the app's own OAuth client id and client secret are stored
 * under, in the SAME encrypted store every other secret in this project
 * uses. Exported so the operator provisioning them with `secret put` (or a
 * test seeding them with `putSecret`) uses the exact spelling this module
 * reads, never a name invented independently.
 */
export const GOOGLE_CLIENT_ID_REF = 'GOOGLE_OAUTH_CLIENT_ID';
export const GOOGLE_CLIENT_SECRET_REF = 'GOOGLE_OAUTH_CLIENT_SECRET';

/** The only provider this implementation actually knows how to talk to. */
const SUPPORTED_PROVIDER = 'google';

const GoogleTokenSuccessBody = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
});

export interface GoogleTokenHttpOptions {
  credentials: CredentialSource;
  businessId: string;
  /**
   * Test seam only. Unreachable from env or config -- the same discipline
   * `buildRuntime`'s `overrides.createTransport` already keeps: no
   * production caller ever passes it.
   */
  fetchImpl?: typeof fetch;
  tokenEndpoint?: string;
}

/**
 * Build the `TokenHttp` `oauthCredentials` calls to mint or refresh a
 * Google access token.
 */
export function googleTokenHttp(options: GoogleTokenHttpOptions): TokenHttp {
  const endpoint = options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async exchangeRefresh(input): Promise<RefreshOutcome> {
      if (input.provider !== SUPPORTED_PROVIDER) {
        // A routing mistake -- this http implementation was wired for a
        // grant it does not know how to serve. Not something a retry in
        // five minutes fixes.
        return {
          ok: false,
          kind: 'rejected',
          message: `googleTokenHttp אינו תומך בספק "${input.provider}"`,
        };
      }

      // Resolved fresh on every call -- see module docblock. A throw here
      // (a store failure, not an absent secret) is left to propagate.
      const [clientId, clientSecret] = await Promise.all([
        options.credentials.resolve(GOOGLE_CLIENT_ID_REF, options.businessId),
        options.credentials.resolve(GOOGLE_CLIENT_SECRET_REF, options.businessId),
      ]);
      if (clientId === null || clientSecret === null) {
        return {
          ok: false,
          kind: 'rejected',
          message:
            'תצורת ה-OAuth של Google חסרה — יש להקציב ' +
            `${GOOGLE_CLIENT_ID_REF} ו-${GOOGLE_CLIENT_SECRET_REF} במאגר הסודות`,
        };
      }

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
        client_id: clientId.value,
        client_secret: clientSecret.value,
      });

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: input.signal,
        });
      } catch (error) {
        // Never reached Google, or Google never answered -- the refresh
        // token itself was never evaluated, so this cannot mean "refused".
        return {
          ok: false,
          kind: 'transient',
          message: `כשל רשת בריענון מול Google: ${errorText(error)}`,
        };
      }

      if (response.status >= 200 && response.status < 300) {
        const parsed = GoogleTokenSuccessBody.safeParse(await readJson(response));
        if (!parsed.success) {
          // A 2xx with a body this code cannot read is not proof the
          // refresh token is bad -- treat it as a hiccup, not a refusal.
          return {
            ok: false,
            kind: 'transient',
            message: 'Google החזיר תשובה תקינה בסטטוס אך עם גוף שלא ניתן לפענח',
          };
        }
        return {
          ok: true,
          accessToken: parsed.data.access_token,
          expiresInSeconds: parsed.data.expires_in,
          rotatedRefreshToken: parsed.data.refresh_token ?? null,
        };
      }

      const errorCode = await readErrorCode(response);
      const suffix = errorCode === null ? '' : ` (${errorCode})`;

      // 429 (rate limited) and 5xx (provider trouble): the provider is not
      // saying anything about the refresh token itself.
      if (response.status === 429 || response.status >= 500) {
        return {
          ok: false,
          kind: 'transient',
          message: `כשל זמני מול Google — סטטוס ${response.status}${suffix}`,
        };
      }

      // Any other 4xx (400 invalid_grant chief among them): the provider
      // looked at the refresh token and said no.
      return {
        ok: false,
        kind: 'rejected',
        message: `Google דחה את הרענון — סטטוס ${response.status}${suffix}`,
      };
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * The provider's own short error CODE only (e.g. `invalid_grant`) -- never
 * the raw body, which may echo request content back. See module docblock.
 */
async function readErrorCode(response: Response): Promise<string | null> {
  const raw = await readJson(response);
  if (typeof raw !== 'object' || raw === null) return null;
  const value = (raw as Record<string, unknown>)['error'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
