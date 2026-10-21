/**
 * The real `TokenHttp` for Microsoft (Microsoft identity platform v2): turns a
 * stored refresh token into a live access token.
 *
 * Mirrors `google-token-http.ts` -- read that module's docblock for the full
 * reasoning behind every classification below. The differences that matter:
 *
 * - **Microsoft ROTATES the refresh token on every refresh.** The response
 *   carries a new `refresh_token`, and the old one may stop working. It is
 *   returned as `rotatedRefreshToken` so `oauthCredentials` re-seals it; a
 *   caller that dropped it would lose the grant within days.
 * - The client credentials are resolved from the encrypted store fresh on
 *   every call (never `process.env`), for the business the call names.
 * - No token value and no raw response body ever reaches `message`.
 */
import { z } from 'zod';
import type { CredentialSource } from '../credentials.js';
import type { RefreshOutcome, TokenHttp } from '../oauth-token.js';

/** The multi-tenant ("common") v2 token endpoint -- work, school and personal accounts. */
export const MICROSOFT_TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

export const MICROSOFT_CLIENT_ID_REF = 'MICROSOFT_OAUTH_CLIENT_ID';
export const MICROSOFT_CLIENT_SECRET_REF = 'MICROSOFT_OAUTH_CLIENT_SECRET';

const SUPPORTED_PROVIDER = 'microsoft';

const MicrosoftTokenSuccessBody = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
});

export interface MicrosoftTokenHttpOptions {
  credentials: CredentialSource;
  /** Test seam only. */
  fetchImpl?: typeof fetch;
}

export function microsoftTokenHttp(options: MicrosoftTokenHttpOptions): TokenHttp {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async exchangeRefresh(input): Promise<RefreshOutcome> {
      if (input.provider !== SUPPORTED_PROVIDER) {
        return {
          ok: false,
          kind: 'misconfigured',
          message: `microsoftTokenHttp אינו תומך בספק "${input.provider}"`,
        };
      }

      const [clientId, clientSecret] = await Promise.all([
        options.credentials.resolve(MICROSOFT_CLIENT_ID_REF, input.businessId),
        options.credentials.resolve(MICROSOFT_CLIENT_SECRET_REF, input.businessId),
      ]);
      if (clientId === null || clientSecret === null) {
        return {
          ok: false,
          kind: 'misconfigured',
          message:
            'תצורת ה-OAuth של Microsoft חסרה — יש להקציב ' +
            `${MICROSOFT_CLIENT_ID_REF} ו-${MICROSOFT_CLIENT_SECRET_REF} במאגר הסודות`,
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
        response = await doFetch(MICROSOFT_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: input.signal,
        });
      } catch (error) {
        return {
          ok: false,
          kind: 'transient',
          message: `כשל רשת בריענון מול Microsoft: ${errorText(error)}`,
        };
      }

      if (response.status >= 200 && response.status < 300) {
        const parsed = MicrosoftTokenSuccessBody.safeParse(await readJson(response));
        if (!parsed.success) {
          return {
            ok: false,
            kind: 'transient',
            message: 'Microsoft החזיר תשובה תקינה בסטטוס אך עם גוף שלא ניתן לפענח',
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

      if (response.status === 429 || response.status >= 500) {
        return {
          ok: false,
          kind: 'transient',
          message: `כשל זמני מול Microsoft — סטטוס ${response.status}${suffix}`,
        };
      }

      // A wrong or expired CLIENT SECRET is the installation's fault, not the
      // grant's -- see `google-token-http.ts` for why re-consent cannot fix it.
      if (response.status === 401 || errorCode === 'invalid_client') {
        return {
          ok: false,
          kind: 'misconfigured',
          message: `תצורת ה-OAuth של Microsoft שגויה — הספק דחה את פרטי האפליקציה${suffix}`,
        };
      }

      return {
        ok: false,
        kind: 'rejected',
        message: `Microsoft דחה את הרענון — סטטוס ${response.status}${suffix}`,
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

/** The provider's own short error CODE only -- never the raw body (it may echo request content). */
async function readErrorCode(response: Response): Promise<string | null> {
  const raw = await readJson(response);
  if (typeof raw !== 'object' || raw === null) return null;
  const value = (raw as Record<string, unknown>)['error'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
