import { describe, expect, it } from 'vitest';
import type { CredentialSource } from '../credentials.js';
import { createCredentialHandle } from './types.js';
import { GOOGLE_CLIENT_ID_REF, GOOGLE_CLIENT_SECRET_REF, googleTokenHttp } from './google-token-http.js';

const BUSINESS = 'test-business';

/** A `CredentialSource` backed by a plain map — no database, no encryption. */
function credentialsFrom(values: Record<string, string>): CredentialSource {
  return {
    async resolve(ref: string, _businessId: string) {
      const value = values[ref];
      return value === undefined ? null : createCredentialHandle(ref, value);
    },
  };
}

function configured(): CredentialSource {
  return credentialsFrom({
    [GOOGLE_CLIENT_ID_REF]: 'client-id-123',
    [GOOGLE_CLIENT_SECRET_REF]: 'client-secret-SENTINEL',
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('googleTokenHttp', () => {
  it('refuses a provider it does not implement, without resolving any credential', async () => {
    let resolved = false;
    const credentials: CredentialSource = {
      async resolve() {
        resolved = true;
        return null;
      },
    };
    const http = googleTokenHttp({ credentials });
    const outcome = await http.exchangeRefresh({
      provider: 'microsoft',
      refreshToken: 'rt',
      businessId: BUSINESS,
      signal: new AbortController().signal,
    });
    // A routing mistake -- Google was never reached, so this is a
    // configuration fact, not something the provider said. Not 'rejected'
    // (fix-round 1, finding I2's reasoning applies here too).
    expect(outcome).toMatchObject({ ok: false, kind: 'misconfigured' });
    expect(resolved).toBe(false);
  });

  it('reports missing app configuration as a TERMINAL failure, and specifically "misconfigured"', async () => {
    const http = googleTokenHttp({ credentials: credentialsFrom({}) });
    const outcome = await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'rt',
      businessId: BUSINESS,
      signal: new AbortController().signal,
    });
    // Positive half: the refusal actually happened and named a reason.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message.length).toBeGreaterThan(0);
    // 'misconfigured', never 'rejected' (that would falsely tell the owner
    // Google refused the grant) and never 'transient' (that sends the
    // scheduler back to retry a config error every five minutes forever).
    expect(outcome.kind).toBe('misconfigured');
  });

  it('reports a client id present with the secret still absent as misconfigured too', async () => {
    // `credentialsFrom({})` above proves neither ref resolving is terminal.
    // This proves the secret missing ON ITS OWN — the more likely real
    // mistake, since an operator provisions the id first — is caught too,
    // not just the "nothing at all provisioned" case.
    const http = googleTokenHttp({
      credentials: credentialsFrom({ [GOOGLE_CLIENT_ID_REF]: 'client-id-123' }),
    });
    const outcome = await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'rt',
      businessId: BUSINESS,
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ ok: false, kind: 'misconfigured' });
  });

  it('mints an access token on a successful exchange', async () => {
    const http = googleTokenHttp({
      credentials: configured(),
      fetchImpl: async () =>
        jsonResponse(200, { access_token: 'access-1', expires_in: 3600, refresh_token: 'rotated-1' }),
    });
    const outcome = await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'rt',
      businessId: BUSINESS,
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({
      ok: true,
      accessToken: 'access-1',
      expiresInSeconds: 3600,
      rotatedRefreshToken: 'rotated-1',
    });
  });

  it('treats an unrotated refresh token as null, not absent', async () => {
    const http = googleTokenHttp({
      credentials: configured(),
      fetchImpl: async () => jsonResponse(200, { access_token: 'access-1', expires_in: 3600 }),
    });
    const outcome = await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'rt',
      businessId: BUSINESS,
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ ok: true, rotatedRefreshToken: null });
  });

  it('treats a 2xx with an unreadable body as transient, not as a refusal', async () => {
    const http = googleTokenHttp({
      credentials: configured(),
      fetchImpl: async () => jsonResponse(200, { nonsense: true }),
    });
    const outcome = await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'rt',
      businessId: BUSINESS,
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ ok: false, kind: 'transient' });
  });

  it('classifies 400 (invalid_grant) as rejected, 429 and 5xx as transient', async () => {
    for (const [status, expectedKind] of [
      [400, 'rejected'],
      [429, 'transient'],
      [503, 'transient'],
    ] as const) {
      const http = googleTokenHttp({
        credentials: configured(),
        fetchImpl: async () => jsonResponse(status, { error: 'invalid_grant' }),
      });
      const outcome = await http.exchangeRefresh({
        provider: 'google',
        refreshToken: 'rt',
        businessId: BUSINESS,
        signal: new AbortController().signal,
      });
      expect(outcome).toMatchObject({ ok: false, kind: expectedKind });
    }
  });

  /**
   * Final fix wave, item 2. Before this fix, 401 fell into the generic
   * "any other 4xx" branch and came back `'rejected'` — the same kind a
   * genuine `invalid_grant` gets — which writes an audit row asserting the
   * provider rejected the *authorisation* and sends the owner through
   * re-consent. Google answers a wrong `client_secret` with 401
   * `invalid_client` without ever looking at the refresh token, and
   * re-consenting resubmits the same broken secret, so that loop can never
   * fix the actual cause. Both signals are checked — the status code alone
   * (`401`) and the provider's own error code (`invalid_client`), since a
   * provider might report either without the other.
   */
  it('classifies a 401 (or invalid_client) as misconfigured, not rejected', async () => {
    for (const [status, body] of [
      [401, { error: 'invalid_client' }],
      [401, {}],
      [400, { error: 'invalid_client' }],
    ] as const) {
      const http = googleTokenHttp({
        credentials: configured(),
        fetchImpl: async () => jsonResponse(status, body),
      });
      const outcome = await http.exchangeRefresh({
        provider: 'google',
        refreshToken: 'rt',
        businessId: BUSINESS,
        signal: new AbortController().signal,
      });
      expect(outcome).toMatchObject({ ok: false, kind: 'misconfigured' });
    }
  });

  it('treats a network failure as transient', async () => {
    const http = googleTokenHttp({
      credentials: configured(),
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const outcome = await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'rt',
      businessId: BUSINESS,
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ ok: false, kind: 'transient' });
  });

  it('lets a credential-store failure propagate rather than reporting it as a rejection', async () => {
    const credentials: CredentialSource = {
      async resolve() {
        throw new Error('database blip');
      },
    };
    const http = googleTokenHttp({ credentials });
    await expect(
      http.exchangeRefresh({
        provider: 'google',
        refreshToken: 'rt',
        businessId: BUSINESS,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('database blip');
  });

  it('never puts the client secret or the refresh token in a failure message', async () => {
    const http = googleTokenHttp({
      credentials: configured(),
      fetchImpl: async () => jsonResponse(400, { error: 'invalid_grant', error_description: 'the full request body, echoed back' }),
    });
    const outcome = await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'REFRESH-SENTINEL',
      businessId: BUSINESS,
      signal: new AbortController().signal,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message.length).toBeGreaterThan(0); // positive half
    expect(outcome.message).not.toContain('REFRESH-SENTINEL');
    expect(outcome.message).not.toContain('client-secret-SENTINEL');
  });

  /**
   * Fix-round 1, finding I3: the original version of this test asserted the
   * secret was NOT in the URL and never asserted it WAS in the body —
   * deleting `client_secret` from the `URLSearchParams` in the
   * implementation left every test in this file green. The positive
   * assertion below is the one that would have caught that.
   */
  it('sends the resolved client id AND secret as form fields, never as query parameters', async () => {
    let capturedBody: string | undefined;
    let capturedUrl: string | undefined;
    const http = googleTokenHttp({
      credentials: configured(),
      fetchImpl: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = typeof init?.body === 'string' ? init.body : undefined;
        return jsonResponse(200, { access_token: 'a', expires_in: 10 });
      },
    });
    await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'rt-1',
      businessId: BUSINESS,
      signal: new AbortController().signal,
    });
    expect(capturedBody).toContain('client_id=client-id-123');
    expect(capturedBody).toContain('client_secret=client-secret-SENTINEL'); // positive half
    expect(capturedBody).toContain('refresh_token=rt-1');
    expect(capturedUrl).not.toContain('client-secret-SENTINEL');
  });

  it('resolves the client id and secret for the business named in the call, not a business baked into construction', async () => {
    const seenBusinessIds: string[] = [];
    const credentials: CredentialSource = {
      async resolve(ref, businessId) {
        seenBusinessIds.push(businessId);
        if (ref === GOOGLE_CLIENT_ID_REF) return createCredentialHandle(ref, 'cid');
        if (ref === GOOGLE_CLIENT_SECRET_REF) return createCredentialHandle(ref, 'csecret');
        return null;
      },
    };
    const http = googleTokenHttp({
      credentials,
      fetchImpl: async () => jsonResponse(200, { access_token: 'a', expires_in: 10 }),
    });
    await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'rt',
      businessId: 'business-b',
      signal: new AbortController().signal,
    });
    expect(seenBusinessIds).toEqual(['business-b', 'business-b']);
  });
});
