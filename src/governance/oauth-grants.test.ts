import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { decryptSecret } from './secret-cipher.js';
import { writeKeyState } from './master-key.js';
import { listGrants, readGrantByRef, readGrantBySystem, revokeGrant, writeGrant } from './oauth-grants.js';

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
    // `liveKeyId` (credential-store.ts) is hardcoded to `config.businessId`
    // -- the installation's own row, not the grant's -- exactly as
    // `putSecret` already relies on. Neither BUSINESS nor OTHER below is
    // that value, so the installation's own key-check row is seeded too;
    // without it every `writeGrant` call fails at `liveKeyId`, before it
    // gets anywhere near the per-business rows this test is actually about.
    await writeKeyState(KEY, 'KEY-test');
    await writeKeyState(KEY, 'KEY-test', { businessId: BUSINESS });
    await writeKeyState(KEY, 'KEY-test', { businessId: OTHER });
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

    expect(await readGrantBySystem(GRANT.system, BUSINESS, KEY)).toBeNull();
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
});
