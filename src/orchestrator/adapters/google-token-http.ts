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
 * **Missing configuration is a TERMINAL failure, and it is `'misconfigured'`,
 * never `'rejected'` and never `'transient'`.** A business that never
 * provisioned the client id/secret refs gets `kind: 'misconfigured'` here.
 * Fix-round 1 (finding I2) is why this is its own kind and not folded into
 * `'rejected'`: `oauthCredentials` treats `'rejected'` as the PROVIDER
 * having looked at the refresh token and refused it — that branch writes an
 * audit row naming the provider and flags the grant for re-consent. An
 * install that simply never ran `secret put GOOGLE_OAUTH_CLIENT_SECRET`
 * never reached Google at all; reporting `'rejected'` for it wrote a false
 * audit row ("Google rejected your refresh") and flagged a grant that
 * re-consenting cannot fix, because the problem was never on Google's side.
 * Nor is it `'transient'`: classifying a configuration error as transient
 * sends `oauthCredentials`' caller, and ultimately the scheduler, back to
 * retry the exact same missing configuration every five minutes forever.
 * The same reasoning applies to a `provider` this implementation was never
 * wired to serve (a routing mistake, not something Google said) — see the
 * `SUPPORTED_PROVIDER` check below, reclassified from `'rejected'` to
 * `'misconfigured'` in the same fix round for the identical reason. A 401
 * `invalid_client` response — a wrong or revoked CLIENT SECRET — is the same
 * mistake one status code over (final fix wave, item 2): the provider never
 * looked at the refresh token, it rejected the caller's own app credentials,
 * and re-consenting cannot fix a broken client secret because re-consent
 * resubmits the same one. `exchangeRefresh` checks `response.status === 401`
 * OR `errorCode === 'invalid_client'` before falling into the generic 4xx
 * branch, since a provider may report either signal without the other.
 *
 * A `CredentialSource.resolve` that THROWS (a database blip resolving the
 * client secret, not an absent one) is a different failure mode again and
 * is deliberately left to propagate uncaught: catching it and reporting
 * `'misconfigured'` or `'rejected'` would send a perfectly live grant into
 * a false terminal state over a transient store failure that has nothing to
 * do with the grant itself. `oauthCredentials`'s own docblock states the
 * same rule for its `fallback` for the same reason.
 *
 * **`businessId` arrives on every call, from `input`, never from an option
 * this factory closes over.** An earlier version took `businessId` as a
 * `GoogleTokenHttpOptions` field and used it for both refs on every call —
 * harmless in a one-business-per-install product, but it reintroduced,
 * inside this one implementation, exactly the "which business is this
 * really for" ambiguity `CredentialSource`'s mandatory, undefaulted
 * `businessId` exists to make unreachable (fix-round 1, finding I6). See
 * `TokenHttp`'s own docblock in `oauth-token.ts`.
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

/**
 * Google's own token endpoint. Not overridable -- there is exactly one, and
 * `tokenEndpoint` as a constructor option was removed in fix-round 1 (M2):
 * an invented seam with no reader anywhere, not even a test.
 */
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
  /**
   * Test seam only. Unreachable from env or config -- the same discipline
   * `buildRuntime`'s `overrides.createTransport` already keeps: no
   * production caller ever passes it.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Build the `TokenHttp` `oauthCredentials` calls to mint or refresh a
 * Google access token.
 */
export function googleTokenHttp(options: GoogleTokenHttpOptions): TokenHttp {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async exchangeRefresh(input): Promise<RefreshOutcome> {
      if (input.provider !== SUPPORTED_PROVIDER) {
        // A routing mistake -- this http implementation was wired for a
        // grant it does not know how to serve. Google was never reached, so
        // this is a configuration fact about the wiring, not something
        // Google said -- 'misconfigured', not 'rejected'. See module docblock.
        return {
          ok: false,
          kind: 'misconfigured',
          message: `googleTokenHttp אינו תומך בספק "${input.provider}"`,
        };
      }

      // Resolved fresh on every call, for the business THIS CALL names --
      // see module docblock. A throw here (a store failure, not an absent
      // secret) is left to propagate.
      const [clientId, clientSecret] = await Promise.all([
        options.credentials.resolve(GOOGLE_CLIENT_ID_REF, input.businessId),
        options.credentials.resolve(GOOGLE_CLIENT_SECRET_REF, input.businessId),
      ]);
      if (clientId === null || clientSecret === null) {
        return {
          ok: false,
          kind: 'misconfigured',
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
        response = await doFetch(DEFAULT_TOKEN_ENDPOINT, {
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

      // A wrong (or revoked) client secret answers 401 `invalid_client` --
      // Google never looked at the refresh token at all, it rejected the
      // caller's own app credentials before getting that far. Reporting this
      // as `'rejected'` told the owner "Google rejected your authorisation"
      // and sent them through a re-consent loop that cannot fix the actual
      // cause, because re-consenting resubmits the SAME broken client
      // secret. This is a fact about what THIS INSTALLATION provisioned, not
      // about the grant or the provider's opinion of it -- `'misconfigured'`,
      // matching the missing-secret branch above for the identical reason
      // (fix-round 2, finding I2 restated one status code over: the mistake
      // ruling I2 was written to prevent, recurring at 401 instead of at "no
      // secret configured at all").
      if (response.status === 401 || errorCode === 'invalid_client') {
        return {
          ok: false,
          kind: 'misconfigured',
          message: `תצורת ה-OAuth של Google שגויה — הספק דחה את פרטי האפליקציה${suffix}`,
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
