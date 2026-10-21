/**
 * Dispatches a refresh to the `TokenHttp` of the grant's own provider.
 *
 * `oauthCredentials` takes ONE `TokenHttp`; with two providers that one is
 * this router. A provider with no entry is `'misconfigured'` (a wiring fact:
 * the provider was never reached), the same classification each concrete
 * implementation gives a provider it was not built for. The lookup is
 * `Object.hasOwn`, never `in`/index: `constructor` or `__proto__` must not
 * resolve to an inherited function.
 */
import type { RefreshOutcome, TokenHttp } from '../oauth-token.js';

export function providerTokenHttp(byProvider: Record<string, TokenHttp>): TokenHttp {
  return {
    async exchangeRefresh(input): Promise<RefreshOutcome> {
      const http = Object.hasOwn(byProvider, input.provider) ? byProvider[input.provider] : undefined;
      if (http === undefined) {
        return {
          ok: false,
          kind: 'misconfigured',
          message: `אין מימוש ריענון לספק "${input.provider}"`,
        };
      }
      return http.exchangeRefresh(input);
    },
  };
}
