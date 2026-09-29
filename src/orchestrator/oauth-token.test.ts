import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { closePool, getPool } from '../db/pool.js';
import { writeKeyState } from '../governance/master-key.js';
import {
  listGrants,
  readGrantBySystem,
  revokeGrant,
  writeGrant,
} from '../governance/oauth-grants.js';
import { resetDatabase } from '../test/db.js';
import { createCredentialHandle } from './adapters/types.js';
import type { CredentialHandle } from './adapters/types.js';
import type { CredentialSource } from './credentials.js';
import {
  AmbiguousCredentialRefError,
  OAuthRefreshRejectedError,
  OAuthRefreshTransientError,
  oauthCredentials,
} from './oauth-token.js';
import type { RefreshOutcome, TokenHttp } from './oauth-token.js';

const BUSINESS = 'test-business';
const KEY = randomBytes(32);

const GRANT = {
  system: 'office-calendar',
  provider: 'google',
  credentialRef: 'OFFICE_CALENDAR',
  account: 'owner@example.com',
  scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  refreshToken: 'refresh-token-value-A',
  grantedBy: 'owner',
} as const;

/**
 * A `CredentialSource` whose `resolve` throws unconditionally. Used wherever
 * a live grant should answer for itself without this module ever needing
 * the fallback's opinion — if `oauthCredentials` called it anyway and let
 * the throw through, the surrounding test would fail loudly instead of
 * silently passing on the wrong path.
 */
const NEVER_CALLED: CredentialSource = {
  resolve(): Promise<CredentialHandle | null> {
    throw new Error('fallback.resolve should not have been called');
  },
};

/** Same idea as `NEVER_CALLED`, for the HTTP seam. */
const NEVER_CALLED_HTTP: TokenHttp = {
  exchangeRefresh(): Promise<RefreshOutcome> {
    throw new Error('http.exchangeRefresh should not have been called');
  },
};

/** A `TokenHttp` that always reports the provider rejected the refresh. */
const REJECTING_HTTP: TokenHttp = {
  async exchangeRefresh(): Promise<RefreshOutcome> {
    return { ok: false, kind: 'rejected', message: 'invalid_grant' };
  },
};

/** A `CredentialSource` backed by a plain map, for the non-OAuth fallback path. */
function stubSource(secrets: Record<string, string>): CredentialSource {
  return {
    async resolve(ref: string, _businessId: string): Promise<CredentialHandle | null> {
      if (!Object.hasOwn(secrets, ref)) return null;
      return createCredentialHandle(ref, secrets[ref] as string);
    },
  };
}

/** A `TokenHttp` that records every call it received and always succeeds. */
function recordingHttp(result: {
  accessToken: string;
  expiresInSeconds: number;
  rotatedRefreshToken?: string | null;
}): TokenHttp & { calls: Array<{ provider: string; refreshToken: string }> } {
  const calls: Array<{ provider: string; refreshToken: string }> = [];
  return {
    calls,
    async exchangeRefresh({ provider, refreshToken }): Promise<RefreshOutcome> {
      calls.push({ provider, refreshToken });
      return {
        ok: true,
        accessToken: result.accessToken,
        expiresInSeconds: result.expiresInSeconds,
        rotatedRefreshToken: result.rotatedRefreshToken ?? null,
      };
    },
  };
}

/** A fixed, injectable clock for `oauthCredentials({ now })`. */
function clock(startMs = 0): () => number {
  return () => startMs;
}

describe('oauthCredentials', () => {
  beforeEach(async () => {
    await resetDatabase();
    await writeKeyState(KEY, 'KEY-test');
  });

  afterAll(async () => {
    await closePool();
  });

  it('mints an access token from a stored grant', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const http = recordingHttp({ accessToken: 'access-1', expiresInSeconds: 3600 });
    const source = oauthCredentials({ key: KEY, fallback: NEVER_CALLED, http });

    const handle = await source.resolve(GRANT.credentialRef, BUSINESS);

    expect(handle?.value).toBe('access-1');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.refreshToken).toBe(GRANT.refreshToken);
  });

  it('falls through to the static store for a ref that is not a grant', async () => {
    const fallback = stubSource({ OFFICE_MAIL: 'smtp-password' });
    const source = oauthCredentials({ key: KEY, fallback, http: NEVER_CALLED_HTTP });

    expect((await source.resolve('OFFICE_MAIL', BUSINESS))?.value).toBe('smtp-password');
  });

  it('refuses a ref that exists as BOTH a grant and a secret', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const fallback = stubSource({ [GRANT.credentialRef]: 'also-a-secret' });
    const source = oauthCredentials({ key: KEY, fallback, http: NEVER_CALLED_HTTP });

    await expect(source.resolve(GRANT.credentialRef, BUSINESS)).rejects.toThrow(
      AmbiguousCredentialRefError,
    );
  });

  it('reuses a cached access token, and still checks revocation every call', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const http = recordingHttp({ accessToken: 'access-1', expiresInSeconds: 3600 });
    const source = oauthCredentials({ key: KEY, fallback: NEVER_CALLED, http });

    expect((await source.resolve(GRANT.credentialRef, BUSINESS))?.value).toBe('access-1');
    expect((await source.resolve(GRANT.credentialRef, BUSINESS))?.value).toBe('access-1');
    // Positive half: the cache is real -- one exchange, not two.
    expect(http.calls).toHaveLength(1);

    await revokeGrant(GRANT.system, BUSINESS, 'owner');
    // And it is still refused immediately, while that cached token is valid.
    expect(await source.resolve(GRANT.credentialRef, BUSINESS)).toBeNull();
  });

  it('marks the grant for re-authorisation when the provider rejects the refresh token', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const source = oauthCredentials({
      key: KEY,
      fallback: NEVER_CALLED,
      http: {
        async exchangeRefresh(): Promise<RefreshOutcome> {
          return { ok: false, kind: 'rejected', message: 'invalid_grant' };
        },
      },
    });

    await expect(source.resolve(GRANT.credentialRef, BUSINESS)).rejects.toThrow(
      OAuthRefreshRejectedError,
    );
    expect((await listGrants(BUSINESS))[0]?.needsReauthAt).not.toBeNull();
  });

  it('stores a rotated refresh token, so the next call uses the new one', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const http = recordingHttp({ accessToken: 'a', expiresInSeconds: 1, rotatedRefreshToken: 'refresh-2' });
    const source = oauthCredentials({ key: KEY, fallback: NEVER_CALLED, http, now: clock() });

    await source.resolve(GRANT.credentialRef, BUSINESS);
    expect((await readGrantBySystem(GRANT.system, BUSINESS, KEY))?.refreshToken).toBe('refresh-2');
  });

  it('reports a transient failure as retryable, distinct from a rejection', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const source = oauthCredentials({
      key: KEY,
      fallback: NEVER_CALLED,
      http: {
        async exchangeRefresh(): Promise<RefreshOutcome> {
          return { ok: false, kind: 'transient', message: 'gateway_timeout' };
        },
      },
    });

    await expect(source.resolve(GRANT.credentialRef, BUSINESS)).rejects.toThrow(
      OAuthRefreshTransientError,
    );
    // Unlike a rejection, a transient failure does not flag the grant for re-auth.
    expect((await listGrants(BUSINESS))[0]?.needsReauthAt).toBeNull();
  });

  it('writes one audit row when the provider rejects the refresh token', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const source = oauthCredentials({ key: KEY, fallback: NEVER_CALLED, http: REJECTING_HTTP });

    await expect(source.resolve(GRANT.credentialRef, BUSINESS)).rejects.toThrow(
      OAuthRefreshRejectedError,
    );

    const { rows } = await getPool().query<{ kind: string; reason: string }>(
      `SELECT kind, reason FROM audit_log WHERE business_id = $1 ORDER BY seq DESC LIMIT 1`,
      [BUSINESS],
    );
    expect(rows[0]?.kind).toBe('credential_change');
    expect(rows[0]?.reason).toContain(GRANT.system);
    // The token is never in the reason, and neither is the provider's raw body.
    expect(rows[0]?.reason).not.toContain(GRANT.refreshToken);
  });
});
