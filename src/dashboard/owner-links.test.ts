import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { registerBusiness, resetDatabase, testDb } from '../test/db.js';
import { createTestOwner, ownerLogin, owesVerify } from '../test/owner.js';
import { login, verifySession, verifyPassword } from './auth.js';
import { isTrustedDevice, issueTrustedDevice } from './second-factor.js';
import { issueOwnerLink, LINK_HOURS, ownerLinkState, redeemOwnerLink } from './owner-links.js';

const BUSINESS = 'test-business';
const OTHER = 'test-business-other';
const INVITED = 'dana@shop.example';
const NEW_PASSWORD = 'a fresh strong password';
const NOW = new Date('2026-11-16T10:00:00.000Z');

beforeEach(async () => {
  await resetDatabase();
  await registerBusiness(BUSINESS);
});

afterAll(async () => {
  await closePool();
});

/** The raw part of `<businessId>.<raw>`. */
function rawOf(pathToken: string): string {
  const dot = pathToken.indexOf('.');
  return pathToken.slice(dot + 1);
}

async function issue(kind: 'invite' | 'password_reset', loginAddress: string, at = NOW): Promise<string> {
  return withBusiness(BUSINESS, (db) => issueOwnerLink(db, { kind, login: loginAddress, issuedBy: 'staff-1' }, at));
}

async function redeem(raw: string, typedLogin: string, password = NEW_PASSWORD, at = NOW) {
  return withBusiness(BUSINESS, (db) => redeemOwnerLink(db, { rawToken: raw, typedLogin, password }, at));
}

describe('issueOwnerLink', () => {
  it('returns <businessId>.<64 hex>, and stores only a hash of the raw token', async () => {
    expect(LINK_HOURS).toBe(72);
    const token = await issue('invite', INVITED);
    expect(token).toMatch(new RegExp(`^${BUSINESS}\\.[0-9a-f]{64}$`));
    const raw = rawOf(token);
    const { rows } = await testDb().query<{ link_hash: string; login: string; expires_at: Date; issued_by: string }>(
      'SELECT link_hash, login, expires_at, issued_by FROM owner_links WHERE business_id = $1',
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.link_hash).not.toBe(raw);
    expect(rows[0]?.link_hash).not.toContain(raw);
    expect(rows[0]?.link_hash).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(rows[0]?.login).toBe(INVITED);
    expect(rows[0]?.issued_by).toBe('staff-1');
    expect(rows[0]?.expires_at.getTime()).toBe(NOW.getTime() + 72 * 3600_000);
  });

  it('a newer link of the same kind for the same login retires the older unused one', async () => {
    const first = rawOf(await issue('invite', INVITED));
    const second = rawOf(await issue('invite', INVITED.toUpperCase()));
    expect(await redeem(first, INVITED)).toEqual({ ok: false, code: 'used' });
    expect(await redeem(second, INVITED)).toEqual({ ok: true, kind: 'invite', username: 'owner' });
  });
});

describe('redeemOwnerLink: invite', () => {
  it('accepts the login typed in another letter case and creates the owner', async () => {
    const raw = rawOf(await issue('invite', INVITED));
    expect(await redeem(raw, '  DANA@Shop.Example ')).toEqual({ ok: true, kind: 'invite', username: 'owner' });
    const { rows } = await testDb().query<{ username: string; login: string; password_hash: string; password_salt: string }>(
      'SELECT username, login, password_hash, password_salt FROM dashboard_users WHERE business_id = $1',
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.username).toBe('owner');
    expect(rows[0]?.login).toBe(INVITED);
    expect(await verifyPassword(NEW_PASSWORD, rows[0]!.password_hash, rows[0]!.password_salt)).toBe(true);
  });

  it('a different email is login_mismatch and does not consume the link', async () => {
    const raw = rawOf(await issue('invite', INVITED));
    expect(await redeem(raw, 'someone@else.example')).toEqual({ ok: false, code: 'login_mismatch' });
    const { rows } = await testDb().query<{ used_at: Date | null }>('SELECT used_at FROM owner_links', []);
    expect(rows[0]?.used_at).toBeNull();
    expect(await redeem(raw, INVITED)).toMatchObject({ ok: true });
  });

  it('a second redemption is used', async () => {
    const raw = rawOf(await issue('invite', INVITED));
    expect(await redeem(raw, INVITED)).toMatchObject({ ok: true });
    expect(await redeem(raw, INVITED)).toEqual({ ok: false, code: 'used' });
  });

  it('two concurrent redemptions: exactly one wins', async () => {
    const raw = rawOf(await issue('invite', INVITED));
    const results = await Promise.all([redeem(raw, INVITED), redeem(raw, INVITED)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'used' }]);
  });

  it('73 hours later is expired, and nothing is created', async () => {
    const raw = rawOf(await issue('invite', INVITED));
    const later = new Date(NOW.getTime() + 73 * 3600_000);
    expect(await redeem(raw, INVITED, NEW_PASSWORD, later)).toEqual({ ok: false, code: 'expired' });
    const { rows } = await testDb().query('SELECT 1 FROM dashboard_users WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(0);
  });

  it('a password under the minimum is weak_password and does not consume the link', async () => {
    const raw = rawOf(await issue('invite', INVITED));
    expect(await redeem(raw, INVITED, 'short')).toEqual({ ok: false, code: 'weak_password' });
    expect(await redeem(raw, INVITED)).toMatchObject({ ok: true });
  });

  it('an unknown token is invalid', async () => {
    expect(await redeem('0'.repeat(64), INVITED)).toEqual({ ok: false, code: 'invalid' });
    expect(await redeem('not-hex', INVITED)).toEqual({ ok: false, code: 'invalid' });
  });

  it('is invalid when an owner already exists for that login, and creates nothing', async () => {
    await createTestOwner(BUSINESS, { username: 'owner', password: 'the existing password', login: INVITED });
    const raw = rawOf(await issue('invite', INVITED));
    expect(await redeem(raw, INVITED)).toEqual({ ok: false, code: 'invalid' });
    const { rows } = await testDb().query('SELECT 1 FROM dashboard_users WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(1);
  });

  it('is invalid when another business already signs in with that address', async () => {
    await createTestOwner(OTHER, { username: 'owner', password: 'the existing password', login: INVITED });
    const raw = rawOf(await issue('invite', INVITED));
    expect(await redeem(raw, INVITED)).toEqual({ ok: false, code: 'invalid' });
    const { rows } = await testDb().query('SELECT 1 FROM dashboard_users WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(0);
  });

  it("a link of one business does not redeem in another", async () => {
    await registerBusiness(OTHER);
    const raw = rawOf(await issue('invite', INVITED));
    const result = await withBusiness(OTHER, (db) =>
      redeemOwnerLink(db, { rawToken: raw, typedLogin: INVITED, password: NEW_PASSWORD }, NOW),
    );
    expect(result).toEqual({ ok: false, code: 'invalid' });
  });
});

describe('redeemOwnerLink: password_reset', () => {
  it('sets the new password and revokes the old session and the trusted device', async () => {
    const existing = ownerLogin(BUSINESS, 'owner');
    await createTestOwner(BUSINESS, { username: 'owner', password: 'the old password here' });
    const old = await withBusiness(BUSINESS, (db) =>
      login(db, { login: existing, password: 'the old password here', pendingFactorFor: owesVerify }),
    );
    if (!old.ok) throw new Error('login failed');
    const device = await withBusiness(BUSINESS, (db) => issueTrustedDevice(db, 'owner'));

    const raw = rawOf(await issue('password_reset', existing));
    expect(await redeem(raw, existing.toUpperCase())).toEqual({ ok: true, kind: 'password_reset', username: 'owner' });

    expect(await withBusiness(BUSINESS, (db) => verifySession(db, old.sessionId))).toBeNull();
    expect(await withBusiness(BUSINESS, (db) => isTrustedDevice(db, 'owner', device))).toBe(false);
    const fresh = await withBusiness(BUSINESS, (db) =>
      login(db, { login: existing, password: NEW_PASSWORD, pendingFactorFor: owesVerify }),
    );
    expect(fresh.ok).toBe(true);
    const stale = await withBusiness(BUSINESS, (db) =>
      login(db, { login: existing, password: 'the old password here', pendingFactorFor: owesVerify }),
    );
    expect(stale.ok).toBe(false);
  });

  it('is invalid when no account signs in with that login', async () => {
    const raw = rawOf(await issue('password_reset', INVITED));
    expect(await redeem(raw, INVITED)).toEqual({ ok: false, code: 'invalid' });
  });

  it('never creates an owner', async () => {
    const raw = rawOf(await issue('password_reset', INVITED));
    expect(await redeem(raw, INVITED)).toEqual({ ok: false, code: 'invalid' });
    const { rows } = await testDb().query('SELECT 1 FROM dashboard_users WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(0);
  });
});

describe('ownerLinkState', () => {
  it('names the kind of a live link and refuses a used or expired one', async () => {
    const raw = rawOf(await issue('invite', INVITED));
    expect(await withBusiness(BUSINESS, (db) => ownerLinkState(db, raw, NOW))).toEqual({ ok: true, kind: 'invite' });
    const later = new Date(NOW.getTime() + 73 * 3600_000);
    expect(await withBusiness(BUSINESS, (db) => ownerLinkState(db, raw, later))).toEqual({ ok: false, code: 'expired' });
    await redeem(raw, INVITED);
    expect(await withBusiness(BUSINESS, (db) => ownerLinkState(db, raw, NOW))).toEqual({ ok: false, code: 'used' });
    expect(await withBusiness(BUSINESS, (db) => ownerLinkState(db, '0'.repeat(64), NOW))).toEqual({
      ok: false,
      code: 'invalid',
    });
  });
});
