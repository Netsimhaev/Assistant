import { describe, expect, it } from 'vitest';
import { createCredentialHandle } from '../orchestrator/adapters/types.js';
import type { CredentialSource } from '../orchestrator/credentials.js';
import {
  buildConsentUrl,
  codeChallengeFor,
  createCodeVerifier,
  exchangeCode,
  fetchGoogleAccount,
} from './oauth-consent.js';

const REDIRECT_URI = 'http://127.0.0.1:4173/oauth/callback';

function fakeCredentials(values: Record<string, string>): CredentialSource {
  return {
    async resolve(ref, _businessId) {
      const value = values[ref];
      return value === undefined ? null : createCredentialHandle(ref, value);
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildConsentUrl', () => {
  it('asks the provider for a refresh token explicitly', () => {
    const url = buildConsentUrl({
      provider: 'google',
      clientId: 'cid',
      redirectUri: REDIRECT_URI,
      scopes: ['s'],
      state: 'st',
      codeChallenge: 'ch',
    });
    // Without these two Google returns no refresh token, and the flow looks
    // successful and dies within the hour.
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('code_challenge_method=S256');
  });

  it('carries the state and the code challenge verbatim, never mutating them', () => {
    const url = new URL(
      buildConsentUrl({
        provider: 'google',
        clientId: 'cid',
        redirectUri: REDIRECT_URI,
        scopes: ['a', 'b'],
        state: 'the-state-value',
        codeChallenge: 'the-challenge-value',
      }),
    );
    expect(url.searchParams.get('state')).toBe('the-state-value');
    expect(url.searchParams.get('code_challenge')).toBe('the-challenge-value');
    expect(url.searchParams.get('scope')).toBe('a b');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
  });

  it('refuses a provider it does not know how to serve', () => {
    expect(() =>
      buildConsentUrl({
        provider: 'microsoft',
        clientId: 'cid',
        redirectUri: REDIRECT_URI,
        scopes: ['s'],
        state: 'st',
        codeChallenge: 'ch',
      }),
    ).toThrow(/microsoft/);
  });
});

describe('createCodeVerifier / codeChallengeFor', () => {
  it('produces a verifier of the RFC 7636 minimum length, and a distinct one each call', () => {
    const a = createCodeVerifier();
    const b = createCodeVerifier();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).not.toBe(b);
  });

  it('derives the same challenge from the same verifier every time (S256 is deterministic)', () => {
    const verifier = createCodeVerifier();
    expect(codeChallengeFor(verifier)).toBe(codeChallengeFor(verifier));
  });

  it('derives different challenges from different verifiers', () => {
    expect(codeChallengeFor('verifier-one')).not.toBe(codeChallengeFor('verifier-two'));
  });
});

describe('exchangeCode', () => {
  const CREDENTIALS = fakeCredentials({
    GOOGLE_OAUTH_CLIENT_ID: 'client-id-value',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret-value',
  });

  it('reports misconfigured when the app secret was never provisioned', async () => {
    const outcome = await exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: REDIRECT_URI,
      credentials: fakeCredentials({}),
      businessId: 'biz',
      fetchImpl: async () => {
        throw new Error('must not be called when the app secret is missing');
      },
    });
    expect(outcome).toEqual(
      expect.objectContaining({ ok: false, kind: 'misconfigured' }),
    );
  });

  it('returns the granted scopes and the refresh token on success, never what was requested', async () => {
    let capturedBody = '';
    const outcome = await exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier-value',
      redirectUri: REDIRECT_URI,
      credentials: CREDENTIALS,
      businessId: 'biz',
      fetchImpl: async (_url, init) => {
        capturedBody = String(init?.body ?? '');
        return jsonResponse(200, {
          access_token: 'access-token-value',
          refresh_token: 'refresh-token-value',
          expires_in: 3600,
          // The provider granted LESS than what a caller might have asked
          // for -- this is what must end up in `grantedScopes`.
          scope: 'https://www.googleapis.com/auth/calendar.readonly',
        });
      },
    });
    expect(outcome).toEqual({
      ok: true,
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
      grantedScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    // PKCE actually travels: the verifier must reach the token request body.
    expect(capturedBody).toContain('code_verifier=verifier-value');
    expect(capturedBody).toContain('grant_type=authorization_code');
  });

  it('succeeds even when the provider omits expires_in, which this module never reads', async () => {
    const outcome = await exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: REDIRECT_URI,
      credentials: CREDENTIALS,
      businessId: 'biz',
      fetchImpl: async () =>
        jsonResponse(200, { access_token: 'access-token-value', refresh_token: 'refresh-token-value' }),
    });
    expect(outcome).toEqual({
      ok: true,
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
      grantedScopes: [],
    });
  });

  it('reports null refreshToken rather than inventing one when the provider omits it', async () => {
    const outcome = await exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: REDIRECT_URI,
      credentials: CREDENTIALS,
      businessId: 'biz',
      fetchImpl: async () =>
        jsonResponse(200, { access_token: 'access-token-value', expires_in: 3600 }),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.refreshToken).toBeNull();
  });

  it('classifies a provider refusal (e.g. invalid_grant) as rejected, never transient', async () => {
    const outcome = await exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: REDIRECT_URI,
      credentials: CREDENTIALS,
      businessId: 'biz',
      fetchImpl: async () => jsonResponse(400, { error: 'invalid_grant' }),
    });
    expect(outcome).toEqual(
      expect.objectContaining({ ok: false, kind: 'rejected' }),
    );
    if (!outcome.ok) expect(outcome.message).toContain('invalid_grant');
  });

  it('classifies a 5xx as transient, never rejected', async () => {
    const outcome = await exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: REDIRECT_URI,
      credentials: CREDENTIALS,
      businessId: 'biz',
      fetchImpl: async () => new Response('oops', { status: 503 }),
    });
    expect(outcome).toEqual(expect.objectContaining({ ok: false, kind: 'transient' }));
  });

  it('classifies a network failure as transient', async () => {
    const outcome = await exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: REDIRECT_URI,
      credentials: CREDENTIALS,
      businessId: 'biz',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(outcome).toEqual(expect.objectContaining({ ok: false, kind: 'transient' }));
  });

  it('never lets the client secret or the refresh token reach a failure message', async () => {
    const outcome = await exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: REDIRECT_URI,
      credentials: CREDENTIALS,
      businessId: 'biz',
      fetchImpl: async () =>
        // A provider that echoes the request body back in an error -- the
        // exact hazard `readErrorCode` exists to refuse.
        jsonResponse(400, {
          error: 'invalid_request',
          echoed_body: 'client_secret=client-secret-value&code_verifier=verifier',
        }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).not.toContain('client-secret-value');
      expect(outcome.message).not.toContain('verifier');
    }
  });
});

describe('fetchGoogleAccount', () => {
  it('reads the account address off the primary calendar id, using the bearer token', async () => {
    let sawAuthHeader = '';
    const account = await fetchGoogleAccount('access-token-value', async (_url, init) => {
      sawAuthHeader = new Headers(init?.headers).get('authorization') ?? '';
      return jsonResponse(200, { id: 'owner@example.com', summary: 'Primary' });
    });
    expect(account).toBe('owner@example.com');
    expect(sawAuthHeader).toBe('Bearer access-token-value');
  });

  it('returns null rather than throwing on a non-2xx response', async () => {
    const account = await fetchGoogleAccount('access-token-value', async () => new Response('nope', { status: 403 }));
    expect(account).toBeNull();
  });

  it('returns null rather than throwing on a network failure', async () => {
    const account = await fetchGoogleAccount('access-token-value', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(account).toBeNull();
  });

  it('returns null when the body has no usable id', async () => {
    const account = await fetchGoogleAccount('access-token-value', async () => jsonResponse(200, {}));
    expect(account).toBeNull();
  });
});
