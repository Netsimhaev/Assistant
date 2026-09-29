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
  OAuthGrantRevokedError,
  OAuthMisconfiguredError,
  OAuthRefreshRejectedError,
  OAuthRefreshTransientError,
  oauthCredentials,
} from './oauth-token.js';
import type { RefreshOutcome, TokenHttp } from './oauth-token.js';

const BUSINESS = 'test-business';
const OTHER_BUSINESS = 'other-test-business';
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
 * A `CredentialSource` backed by a plain map that records every ref it was
 * asked about. An empty map (`stubSource({})`) is the honest replacement for
 * a throwing double: it answers `null` truthfully wherever a real
 * `envCredentials`/`storedCredentials` would, so a test can assert exactly
 * how many times — and on which refs — the fallback was actually consulted,
 * which a throwing double cannot distinguish from "never called" (fix round
 * 1, C1: a bare catch around a genuinely rejecting fallback misreports a
 * database blip as a permanent misconfiguration).
 */
function stubSource(secrets: Record<string, string>): CredentialSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolve(ref: string, _businessId: string): Promise<CredentialHandle | null> {
      calls.push(ref);
      if (!Object.hasOwn(secrets, ref)) return null;
      return createCredentialHandle(ref, secrets[ref] as string);
    },
  };
}

/**
 * A `TokenHttp` whose `exchangeRefresh` throws unconditionally. Kept ONLY for
 * `TokenHttp`, not `CredentialSource`: the sites that use it (a ref that is
 * not a grant at all, or an ambiguity refusal) are structurally unreachable
 * before the exchange call regardless of what any double does, so a throw
 * there proves a real control-flow bug rather than merely disagreeing with a
 * fallback's honest answer the way C1 found for `CredentialSource`.
 */
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

/**
 * A `TokenHttp` that always reports this INSTALLATION never provisioned its
 * own app configuration (the OAuth client id/secret) -- the provider was
 * never reached, unlike `REJECTING_HTTP` above.
 */
const MISCONFIGURED_HTTP: TokenHttp = {
  async exchangeRefresh(): Promise<RefreshOutcome> {
    return { ok: false, kind: 'misconfigured', message: 'GOOGLE_OAUTH_CLIENT_SECRET not provisioned' };
  },
};

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

  it('mints an access token from a stored grant, consulting the fallback once to rule out ambiguity', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const fallback = stubSource({});
    const http = recordingHttp({ accessToken: 'access-1', expiresInSeconds: 3600 });
    const source = oauthCredentials({ key: KEY, fallback, http });

    const handle = await source.resolve(GRANT.credentialRef, BUSINESS);

    expect(handle?.value).toBe('access-1');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.refreshToken).toBe(GRANT.refreshToken);
    // The fallback WAS consulted (to rule out ambiguity) and answered
    // honestly with "nothing here" -- that is the correct, expected
    // behaviour now, not something to avoid.
    expect(fallback.calls).toEqual([GRANT.credentialRef]);
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
    expect(fallback.calls).toEqual([GRANT.credentialRef]);
  });

  it('reuses a cached access token without re-consulting the fallback, and refuses outright once revoked', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const fallback = stubSource({});
    const http = recordingHttp({ accessToken: 'access-1', expiresInSeconds: 3600 });
    const source = oauthCredentials({ key: KEY, fallback, http });

    expect((await source.resolve(GRANT.credentialRef, BUSINESS))?.value).toBe('access-1');
    expect((await source.resolve(GRANT.credentialRef, BUSINESS))?.value).toBe('access-1');
    // Positive half: the cache is real -- one exchange, not two, and the
    // fallback was consulted exactly once (the first call's ambiguity
    // check) -- the cache hit on the second call skips it entirely.
    expect(http.calls).toHaveLength(1);
    expect(fallback.calls).toEqual([GRANT.credentialRef]);

    await revokeGrant(GRANT.system, BUSINESS, 'owner');
    // Fix round 1, I3: a revoked grant refuses outright -- it does not fall
    // through to the (honest, empty) fallback and does not return null.
    await expect(source.resolve(GRANT.credentialRef, BUSINESS)).rejects.toThrow(
      OAuthGrantRevokedError,
    );
    // And the refusal did not consult the fallback either.
    expect(fallback.calls).toEqual([GRANT.credentialRef]);
  });

  it('marks the grant for re-authorisation when the provider rejects the refresh token, and threads the provider message through', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const source = oauthCredentials({ key: KEY, fallback: stubSource({}), http: REJECTING_HTTP });

    let caught: unknown;
    try {
      await source.resolve(GRANT.credentialRef, BUSINESS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OAuthRefreshRejectedError);
    expect((caught as Error).message).toContain('invalid_grant');
    expect((await listGrants(BUSINESS))[0]?.needsReauthAt).not.toBeNull();
  });

  /**
   * The direct contrast to the 'rejected' test just above (fix round 2,
   * finding I2 — not addressed in round 1, because this test did not exist
   * yet). Same grant, same call shape, same assertions in the same order —
   * only the `TokenHttp` outcome's `kind` differs. Read the two side by
   * side: 'rejected' writes an audit row naming the provider AND flags
   * `needsReauthAt`; 'misconfigured' does NEITHER, because the provider was
   * never reached and there is nothing true to say about it, and
   * re-consenting cannot fix a local secret nobody provisioned.
   */
  it('reports a missing local configuration as terminal, WITHOUT the audit row or the re-auth flag a real rejection gets', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const source = oauthCredentials({ key: KEY, fallback: stubSource({}), http: MISCONFIGURED_HTTP });

    const before = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE business_id = $1`,
      [BUSINESS],
    );

    // Positive half FIRST: the call actually reached the refresh path and
    // threw the RIGHT class. Everything below is meaningless on a resolve
    // that never got there.
    let caught: unknown;
    try {
      await source.resolve(GRANT.credentialRef, BUSINESS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OAuthMisconfiguredError);
    expect((caught as Error).message).toContain('GOOGLE_OAUTH_CLIENT_SECRET not provisioned');

    // No audit row was written at all — contrast with the 'rejected' test
    // above, which asserts exactly one new `credential_change` row naming
    // the provider and the system.
    const after = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);

    // `needsReauthAt` is still null — this is the assertion that separates
    // "terminal" from "the provider refused you", and the one an owner's
    // actual experience depends on: a grant flagged here would tell them to
    // re-consent, which does nothing for a secret nobody put in the store.
    expect((await listGrants(BUSINESS))[0]?.needsReauthAt).toBeNull();
  });

  it('reports a transient failure as retryable, distinct from a rejection, and does not flag re-auth', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const source = oauthCredentials({
      key: KEY,
      fallback: stubSource({}),
      http: {
        async exchangeRefresh(): Promise<RefreshOutcome> {
          return { ok: false, kind: 'transient', message: 'gateway_timeout' };
        },
      },
    });

    let caught: unknown;
    try {
      await source.resolve(GRANT.credentialRef, BUSINESS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OAuthRefreshTransientError);
    expect((caught as Error).message).toContain('gateway_timeout');
    // Unlike a rejection, a transient failure does not flag the grant for re-auth.
    expect((await listGrants(BUSINESS))[0]?.needsReauthAt).toBeNull();
  });

  /**
   * Final fix wave, item 13. Before this fix, the title promised "so the
   * next call uses the new one" but the test made only ONE call and asserted
   * the DB row directly — it proved rotation is PERSISTED, never that a
   * SUBSEQUENT resolve actually reads the rotated token back and sends it to
   * the provider. The injected `clock()` was decorative for the same reason:
   * nothing in the test ever needed the time to pass, because there was no
   * second call for a cache decision to apply to.
   *
   * `expiresInSeconds: 1` combined with a clock fixed at `0` is what makes
   * the SECOND call below skip the cache rather than hit it: `SKEW_MS` (60s)
   * is larger than the 1-second lifetime, so `cached.expiresAtMs (1000) >
   * nowMs() + SKEW_MS (60000)` is false on every subsequent check regardless
   * of how long the clock claims to have run — the cache never looks fresh,
   * so the second `resolve` genuinely re-reads the (by then rotated) grant
   * from the database and exchanges IT, not a memoised value from the first
   * call.
   */
  it('reads the rotated refresh token back on the next call, not just persists it', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const http = recordingHttp({ accessToken: 'a', expiresInSeconds: 1, rotatedRefreshToken: 'refresh-2' });
    const source = oauthCredentials({ key: KEY, fallback: stubSource({}), http, now: clock() });

    await source.resolve(GRANT.credentialRef, BUSINESS);
    // Positive half: rotation really was persisted before the second call
    // depends on it.
    expect((await readGrantBySystem(GRANT.system, BUSINESS, KEY))?.refreshToken).toBe('refresh-2');

    await source.resolve(GRANT.credentialRef, BUSINESS);
    // The load-bearing assertion the old title promised and never checked:
    // the SECOND exchange call carried the rotated token, not the original
    // one the grant was created with.
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0]?.refreshToken).toBe(GRANT.refreshToken);
    expect(http.calls[1]?.refreshToken).toBe('refresh-2');
  });

  it('writes one audit row when the provider rejects the refresh token', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const source = oauthCredentials({ key: KEY, fallback: stubSource({}), http: REJECTING_HTTP });

    await expect(source.resolve(GRANT.credentialRef, BUSINESS)).rejects.toThrow(
      OAuthRefreshRejectedError,
    );

    const { rows } = await getPool().query<{ kind: string; reason: string }>(
      `SELECT kind, reason FROM audit_log WHERE business_id = $1 ORDER BY seq DESC LIMIT 1`,
      [BUSINESS],
    );
    expect(rows[0]?.kind).toBe('credential_change');
    expect(rows[0]?.reason).toContain(GRANT.system);
    expect(rows[0]?.reason).toContain('invalid_grant');
    // The token is never in the reason, and neither is the provider's raw body.
    expect(rows[0]?.reason).not.toContain(GRANT.refreshToken);
  });

  it('gives each business its own cached access token under the same ref and system', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    await writeGrant(
      { businessId: OTHER_BUSINESS, ...GRANT, refreshToken: 'refresh-token-value-B' },
      KEY,
    );
    const http = recordingHttp({ accessToken: 'access-for-a', expiresInSeconds: 3600 });
    const source = oauthCredentials({ key: KEY, fallback: stubSource({}), http, now: clock() });

    const first = await source.resolve(GRANT.credentialRef, BUSINESS);
    const second = await source.resolve(GRANT.credentialRef, OTHER_BUSINESS);

    expect(first?.value).toBe('access-for-a');
    expect(second?.value).toBe('access-for-a'); // same stub response, different call
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0]?.refreshToken).toBe(GRANT.refreshToken);
    expect(http.calls[1]?.refreshToken).toBe('refresh-token-value-B');
  });

  /**
   * Final fix wave, item 12 — the unit-level half. `binding-health.test.ts`
   * proves the WIRING (a real `runPlan` call, on a 401 from the resource
   * call, reaches this method with the right `ref`/`businessId`); this
   * proves the MECHANISM itself: that calling `invalidate` genuinely forces
   * a fresh mint rather than merely existing as a method that compiles.
   * `expiresInSeconds: 3600` with the clock fixed at `0` means the cache
   * would otherwise still read as fresh — the only thing that can explain a
   * SECOND exchange call below is `invalidate` actually having removed the
   * entry.
   */
  it('invalidate forces the next resolve to mint a fresh token, even though the cached one has not expired', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const http = recordingHttp({ accessToken: 'access-1', expiresInSeconds: 3600 });
    const source = oauthCredentials({ key: KEY, fallback: stubSource({}), http, now: clock() });

    expect((await source.resolve(GRANT.credentialRef, BUSINESS))?.value).toBe('access-1');
    // Positive half: without invalidation, the cache genuinely does hold —
    // a second resolve here would NOT re-exchange (the sibling test above
    // already proves this for the same fixture shape).
    expect(http.calls).toHaveLength(1);

    source.invalidate?.(GRANT.credentialRef, BUSINESS);
    await source.resolve(GRANT.credentialRef, BUSINESS);

    expect(http.calls).toHaveLength(2);
  });

  it('invalidate on a ref with nothing cached is a silent no-op', async () => {
    const source = oauthCredentials({ key: KEY, fallback: stubSource({}), http: NEVER_CALLED_HTTP });
    expect(() => source.invalidate?.('NEVER_RESOLVED', BUSINESS)).not.toThrow();
  });
});
