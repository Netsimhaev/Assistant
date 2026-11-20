/**
 * Revoking an OAuth token at the provider — the one network call shared by
 * the owner's "disconnect" (`handleOAuthRevoke`, `src/dashboard/oauth-routes.ts`)
 * and the head admin's whole-business deletion (`revokeBusinessGrants`,
 * `src/tenancy/business-deletion.ts`).
 *
 * Lives in `src/governance/` rather than beside the OAuth routes so that
 * `src/tenancy/` can use it without importing anything under `src/dashboard/`.
 * For the same reason the Google endpoint is declared here and re-exported by
 * `oauth-profiles.ts`: one constant, so the profile a ceremony uses and the
 * endpoint a deletion revokes at cannot drift apart
 * (`business-deletion.test.ts` checks every profile against
 * `revokeUrlForProvider`).
 *
 * **The token travels in the form body and nowhere else** — not the URL, not
 * a header. This function never logs, and never includes the token or a
 * provider's reply in what it returns: the result is one of two words.
 */

export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/**
 * The provider's token revocation endpoint, by the provider a grant names.
 * Positive matching: only Google has one. Microsoft offers no revocation
 * endpoint for this flow, and any provider this function does not recognise
 * gets `null` — never a guess.
 */
export function revokeUrlForProvider(provider: string): string | null {
  return provider === 'google' ? GOOGLE_REVOKE_URL : null;
}

export interface RevokeAtProviderInput {
  revokeUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /**
   * When set, the call is raced against this deadline and aborted at it — a
   * provider that never answers counts as `failed`. When unset, no deadline
   * is added (the owner's disconnect route, unchanged).
   */
  deadlineMs?: number;
}

/**
 * One POST of the token to the provider. `revoked` only on a 2xx answer;
 * anything else — another status, a network error, the deadline — is
 * `failed`. Never throws.
 */
export async function revokeAtProvider(input: RevokeAtProviderInput): Promise<'revoked' | 'failed'> {
  const doFetch = input.fetchImpl ?? fetch;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: input.token }).toString(),
  };
  if (input.deadlineMs === undefined) {
    try {
      const response = await doFetch(input.revokeUrl, init);
      return response.status >= 200 && response.status < 300 ? 'revoked' : 'failed';
    } catch {
      return 'failed';
    }
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'failed'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('failed');
    }, input.deadlineMs);
  });
  const call = (async (): Promise<'revoked' | 'failed'> => {
    try {
      const response = await doFetch(input.revokeUrl, { ...init, signal: controller.signal });
      return response.status >= 200 && response.status < 300 ? 'revoked' : 'failed';
    } catch {
      return 'failed';
    }
  })();
  try {
    // Raced, not only signalled: a fetch that ignores the signal must not
    // hold the caller past the deadline.
    return await Promise.race([call, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
