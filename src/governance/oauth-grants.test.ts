import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { decryptSecret } from './secret-cipher.js';
import { writeKeyState } from './master-key.js';
import {
  OAuthGrantError,
  listGrants,
  markNeedsReauth,
  readGrantByRef,
  readGrantBySystem,
  recordRefresh,
  revokeGrant,
  writeGrant,
} from './oauth-grants.js';

const BUSINESS = 'test-business';
const OTHER = 'other-business';
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

describe('the OAuth grant store', () => {
  beforeEach(async () => {
    await resetDatabase();
    // Install-wide, exactly like `credential-store.test.ts`'s own
    // `beforeEach`: `writeGrant`/`recordRefresh` now check the key state
    // under `config.businessId` only (fix round 1, Important 3), matching
    // `liveKeyId`, which has never taken a business at all. One row is
    // therefore enough for every business this file uses -- BUSINESS and
    // OTHER included -- and a per-business row would just be unread.
    await writeKeyState(KEY, 'KEY-test');
  });

  afterAll(async () => {
    await closePool();
  });

  it('round-trips a grant, and the token is nowhere but the ciphertext', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);

    const read = await readGrantByRef(GRANT.credentialRef, BUSINESS, KEY);
    expect(read?.refreshToken).toBe(GRANT.refreshToken);
    expect(read?.account).toBe(GRANT.account);
    expect(read?.scopes).toEqual([...GRANT.scopes]);

    // The positive half is above. Now: the value appears in no other column.
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM oauth_grants
        WHERE business_id = $1
          AND (provider LIKE $2 OR credential_ref LIKE $2 OR account LIKE $2
               OR array_to_string(scopes, ' ') LIKE $2 OR granted_by LIKE $2)`,
      [BUSINESS, `%${GRANT.refreshToken}%`],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('gives each business its own grant when both store the same ref', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    await writeGrant({ businessId: OTHER, ...GRANT, refreshToken: 'refresh-token-value-B' }, KEY);

    expect((await readGrantByRef(GRANT.credentialRef, BUSINESS, KEY))?.refreshToken).toBe('refresh-token-value-A');
    expect((await readGrantByRef(GRANT.credentialRef, OTHER, KEY))?.refreshToken).toBe('refresh-token-value-B');
  });

  it('cannot be opened as if it were a secret', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const { rows } = await getPool().query<{ ciphertext: Buffer; nonce: Buffer }>(
      'SELECT ciphertext, nonce FROM oauth_grants WHERE business_id = $1 AND system = $2',
      [BUSINESS, GRANT.system],
    );
    const sealed = { ciphertext: rows[0]!.ciphertext, nonce: rows[0]!.nonce };

    // The AAD a secret would be opened under: the bare ref, uppercase.
    expect(decryptSecret(sealed, KEY, { businessId: BUSINESS, ref: GRANT.credentialRef })).toBeNull();
    // And the AAD it was actually sealed under opens it -- the positive half,
    // so the null above is the binding working and not a broken write.
    expect(decryptSecret(sealed, KEY, { businessId: BUSINESS, ref: `grant:${GRANT.system}` })).toBe(GRANT.refreshToken);
  });

  it('revokes softly: the row stays, and a read refuses it', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    expect(await revokeGrant(GRANT.system, BUSINESS, 'owner')).toBe(true);

    // Both read paths, not just one -- a mutation dropping the
    // `revoked_at IS NULL` predicate from `readGrantByRef` alone would stay
    // green if only `readGrantBySystem` were checked here.
    expect(await readGrantBySystem(GRANT.system, BUSINESS, KEY)).toBeNull();
    expect(await readGrantByRef(GRANT.credentialRef, BUSINESS, KEY)).toBeNull();
    const summaries = await listGrants(BUSINESS);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.revokedAt).not.toBeNull();
  });

  it('never returns the token from listGrants', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const summaries = await listGrants(BUSINESS);
    expect(JSON.stringify(summaries)).not.toContain(GRANT.refreshToken);
    expect(summaries[0]?.account).toBe(GRANT.account);
  });

  // 035_oauth_grants_partial_ref.sql: the unique index on (business_id,
  // credential_ref) only covers live rows, because revocation is soft.
  it('frees a ref for reuse once the grant holding it is revoked', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    await revokeGrant(GRANT.system, BUSINESS, 'owner');

    // Before 035 this raised a raw Postgres unique-violation instead of
    // succeeding: the old, unconditional index still counted the revoked
    // row as occupying the ref.
    await writeGrant(
      { businessId: BUSINESS, ...GRANT, system: 'office-calendar-v2' },
      KEY,
    );

    const revived = await readGrantByRef(GRANT.credentialRef, BUSINESS, KEY);
    expect(revived?.system).toBe('office-calendar-v2');
  });

  // Nested, not sibling: both blocks below need the outer `beforeEach`'s
  // `resetDatabase` + `writeKeyState`, exactly as every test above does.
  describe('recordRefresh', () => {
    it('advances the count and timestamp without touching the token when nothing rotated', async () => {
      await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
      const before = await readGrantBySystem(GRANT.system, BUSINESS, KEY);
      expect(before?.refreshCount).toBe(0);
      expect(before?.lastRefreshedAt).toBeNull();

      await recordRefresh(GRANT.system, BUSINESS, null, KEY);

      const after = await readGrantBySystem(GRANT.system, BUSINESS, KEY);
      // The positive half: the token is UNCHANGED, not merely "no error".
      expect(after?.refreshToken).toBe(GRANT.refreshToken);
      expect(after?.refreshCount).toBe(1);
      expect(after?.lastRefreshedAt).not.toBeNull();
    });

    it('reseals the ciphertext when the provider rotated the refresh token', async () => {
      await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);

      await recordRefresh(GRANT.system, BUSINESS, 'refresh-token-value-rotated', KEY);

      const after = await readGrantBySystem(GRANT.system, BUSINESS, KEY);
      expect(after?.refreshToken).toBe('refresh-token-value-rotated');
      expect(after?.refreshCount).toBe(1);
    });

    it('throws rather than silently doing nothing when no live grant matches', async () => {
      // Both branches -- the plain count bump and the re-seal -- have their
      // own UPDATE statement, so both need their own proof that a miss is
      // not indistinguishable from success.
      await expect(recordRefresh('no-such-system', BUSINESS, null, KEY)).rejects.toThrow(
        OAuthGrantError,
      );
      await expect(
        recordRefresh('no-such-system', BUSINESS, 'rotated-value', KEY),
      ).rejects.toThrow(OAuthGrantError);
    });

    it('refuses to refresh a grant the owner already revoked', async () => {
      await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
      expect(await revokeGrant(GRANT.system, BUSINESS, 'owner')).toBe(true);

      await expect(recordRefresh(GRANT.system, BUSINESS, null, KEY)).rejects.toThrow(
        OAuthGrantError,
      );
    });
  });

  describe('markNeedsReauth', () => {
    it('flags a live grant for re-consent', async () => {
      await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
      const before = await listGrants(BUSINESS);
      expect(before[0]?.needsReauthAt).toBeNull();

      await markNeedsReauth(GRANT.system, BUSINESS);

      const after = await listGrants(BUSINESS);
      expect(after[0]?.needsReauthAt).not.toBeNull();
    });

    it('throws rather than silently doing nothing when no live grant matches', async () => {
      await expect(markNeedsReauth('no-such-system', BUSINESS)).rejects.toThrow(OAuthGrantError);
    });

    it('refuses to flag a grant the owner already revoked', async () => {
      await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
      expect(await revokeGrant(GRANT.system, BUSINESS, 'owner')).toBe(true);

      await expect(markNeedsReauth(GRANT.system, BUSINESS)).rejects.toThrow(OAuthGrantError);
    });
  });
});
