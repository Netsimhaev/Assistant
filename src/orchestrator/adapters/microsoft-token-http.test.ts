import { describe, expect, it } from 'vitest';
import type { CredentialSource } from '../credentials.js';
import { createCredentialHandle } from './types.js';
import {
  MICROSOFT_CLIENT_ID_REF,
  MICROSOFT_CLIENT_SECRET_REF,
  microsoftTokenHttp,
} from './microsoft-token-http.js';

const BUSINESS = 'test-business';

function credentialsFrom(values: Record<string, string>): CredentialSource {
  return {
    async resolve(ref: string, _businessId: string) {
      const value = values[ref];
      return value === undefined ? null : createCredentialHandle(ref, value);
    },
  };
}

const CONFIGURED = credentialsFrom({
  [MICROSOFT_CLIENT_ID_REF]: 'ms-client-id',
  [MICROSOFT_CLIENT_SECRET_REF]: 'ms-client-secret-SENTINEL',
});

const input = {
  provider: 'microsoft',
  refreshToken: 'old-refresh',
  businessId: BUSINESS,
  signal: new AbortController().signal,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('microsoftTokenHttp', () => {
  it('returns rotatedRefreshToken from the response', async () => {
    let calledUrl = '';
    let sentBody = '';
    const http = microsoftTokenHttp({
      credentials: CONFIGURED,
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        calledUrl = url.toString();
        sentBody = String(init?.body ?? '');
        return jsonResponse(200, { access_token: 'at', expires_in: 3599, refresh_token: 'new-refresh' });
      }) as typeof fetch,
    });
    const outcome = await http.exchangeRefresh(input);
    expect(outcome).toEqual({
      ok: true,
      accessToken: 'at',
      expiresInSeconds: 3599,
      rotatedRefreshToken: 'new-refresh',
    });
    expect(calledUrl).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(sentBody).toContain('grant_type=refresh_token');
    expect(sentBody).toContain('refresh_token=old-refresh');
  });

  it('maps invalid_grant to rejected, without leaking the secret', async () => {
    const http = microsoftTokenHttp({
      credentials: CONFIGURED,
      fetchImpl: (async () => jsonResponse(400, { error: 'invalid_grant' })) as typeof fetch,
    });
    const outcome = await http.exchangeRefresh(input);
    expect(outcome).toMatchObject({ ok: false, kind: 'rejected' });
    expect(JSON.stringify(outcome)).not.toContain('SENTINEL');
  });

  it('maps invalid_client to misconfigured, 5xx to transient, missing refs to misconfigured', async () => {
    const bad = microsoftTokenHttp({
      credentials: CONFIGURED,
      fetchImpl: (async () => jsonResponse(401, { error: 'invalid_client' })) as typeof fetch,
    });
    expect(await bad.exchangeRefresh(input)).toMatchObject({ ok: false, kind: 'misconfigured' });
    const flaky = microsoftTokenHttp({
      credentials: CONFIGURED,
      fetchImpl: (async () => jsonResponse(503, {})) as typeof fetch,
    });
    expect(await flaky.exchangeRefresh(input)).toMatchObject({ ok: false, kind: 'transient' });
    const missing = microsoftTokenHttp({ credentials: credentialsFrom({}) });
    expect(await missing.exchangeRefresh(input)).toMatchObject({ ok: false, kind: 'misconfigured' });
  });

  it('refuses a provider it does not implement', async () => {
    const http = microsoftTokenHttp({ credentials: CONFIGURED });
    expect(await http.exchangeRefresh({ ...input, provider: 'google' })).toMatchObject({
      ok: false,
      kind: 'misconfigured',
    });
  });
});
