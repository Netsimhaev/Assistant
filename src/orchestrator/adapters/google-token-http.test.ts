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
    const http = googleTokenHttp({ credentials, businessId: BUSINESS });
    const outcome = await http.exchangeRefresh({
      provider: 'microsoft',
      refreshToken: 'rt',
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ ok: false, kind: 'rejected' });
    expect(resolved).toBe(false);
  });

  it('reports missing app configuration as a TERMINAL failure, not transient', async () => {
    const http = googleTokenHttp({ credentials: credentialsFrom({}), businessId: BUSINESS });
    const outcome = await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'rt',
      signal: new AbortController().signal,
    });
    // Positive half: the refusal actually happened and named a reason.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message.length).toBeGreaterThan(0);
    // The classification itself: 'rejected', never 'transient' — a
    // misclassification here sends the scheduler back to retry a config
    // error every five minutes forever.
    expect(outcome.kind).toBe('rejected');
  });

  it('mints an access token on a successful exchange', async () => {
    const http = googleTokenHttp({
      credentials: configured(),
      businessId: BUSINESS,
      fetchImpl: async () =>
        jsonResponse(200, { access_token: 'access-1', expires_in: 3600, refresh_token: 'rotated-1' }),
    });
    const outcome = await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'rt',
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
      businessId: BUSINESS,
      fetchImpl: async () => jsonResponse(200, { access_token: 'access-1', expires_in: 3600 }),
    });
    const outcome = await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'rt',
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ ok: true, rotatedRefreshToken: null });
  });

  it('treats a 2xx with an unreadable body as transient, not as a refusal', async () => {
    const http = googleTokenHttp({
      credentials: configured(),
      businessId: BUSINESS,
      fetchImpl: async () => jsonResponse(200, { nonsense: true }),
    });
    const outcome = await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'rt',
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
        businessId: BUSINESS,
        fetchImpl: async () => jsonResponse(status, { error: 'invalid_grant' }),
      });
      const outcome = await http.exchangeRefresh({
        provider: 'google',
        refreshToken: 'rt',
        signal: new AbortController().signal,
      });
      expect(outcome).toMatchObject({ ok: false, kind: expectedKind });
    }
  });

  it('treats a network failure as transient', async () => {
    const http = googleTokenHttp({
      credentials: configured(),
      businessId: BUSINESS,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const outcome = await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'rt',
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
    const http = googleTokenHttp({ credentials, businessId: BUSINESS });
    await expect(
      http.exchangeRefresh({ provider: 'google', refreshToken: 'rt', signal: new AbortController().signal }),
    ).rejects.toThrow('database blip');
  });

  it('never puts the client secret or the refresh token in a failure message', async () => {
    const http = googleTokenHttp({
      credentials: configured(),
      businessId: BUSINESS,
      fetchImpl: async () => jsonResponse(400, { error: 'invalid_grant', error_description: 'the full request body, echoed back' }),
    });
    const outcome = await http.exchangeRefresh({
      provider: 'google',
      refreshToken: 'REFRESH-SENTINEL',
      signal: new AbortController().signal,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message.length).toBeGreaterThan(0); // positive half
    expect(outcome.message).not.toContain('REFRESH-SENTINEL');
    expect(outcome.message).not.toContain('client-secret-SENTINEL');
  });

  it('sends the resolved client id and secret as form fields, never as query parameters', async () => {
    let capturedBody: string | undefined;
    let capturedUrl: string | undefined;
    const http = googleTokenHttp({
      credentials: configured(),
      businessId: BUSINESS,
      fetchImpl: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = typeof init?.body === 'string' ? init.body : undefined;
        return jsonResponse(200, { access_token: 'a', expires_in: 10 });
      },
    });
    await http.exchangeRefresh({ provider: 'google', refreshToken: 'rt-1', signal: new AbortController().signal });
    expect(capturedUrl).not.toContain('client-secret-SENTINEL');
    expect(capturedBody).toContain('client_id=client-id-123');
    expect(capturedBody).toContain('refresh_token=rt-1');
  });
});
