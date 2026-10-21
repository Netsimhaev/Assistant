import { describe, expect, it } from 'vitest';
import type { RefreshOutcome, TokenHttp } from '../oauth-token.js';
import { providerTokenHttp } from './provider-token-http.js';

function stub(label: string): TokenHttp {
  return {
    async exchangeRefresh(): Promise<RefreshOutcome> {
      return { ok: true, accessToken: label, expiresInSeconds: 1, rotatedRefreshToken: null };
    },
  };
}

const call = (provider: string) => ({
  provider,
  refreshToken: 'rt',
  businessId: 'b',
  signal: new AbortController().signal,
});

describe('providerTokenHttp', () => {
  const http = providerTokenHttp({ google: stub('g'), microsoft: stub('m') });

  it('routes google and microsoft, unknown is misconfigured', async () => {
    expect(await http.exchangeRefresh(call('google'))).toMatchObject({ ok: true, accessToken: 'g' });
    expect(await http.exchangeRefresh(call('microsoft'))).toMatchObject({ ok: true, accessToken: 'm' });
    expect(await http.exchangeRefresh(call('yahoo'))).toMatchObject({ ok: false, kind: 'misconfigured' });
  });

  it('does not resolve inherited object keys as providers', async () => {
    expect(await http.exchangeRefresh(call('constructor'))).toMatchObject({ ok: false, kind: 'misconfigured' });
    expect(await http.exchangeRefresh(call('__proto__'))).toMatchObject({ ok: false, kind: 'misconfigured' });
  });
});
