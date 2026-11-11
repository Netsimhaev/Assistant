import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, withBusiness } from '../db/pool.js';
import { writeKeyState } from '../governance/master-key.js';
import { revokeGrant, writeGrant } from '../governance/oauth-grants.js';
import { upsertBinding } from '../orchestrator/bindings.js';
import { resetDatabase } from '../test/db.js';
import { CALENDAR_SYSTEM } from './calendar.js';
import { resolveCalendarAccess } from './client-for.js';

const BUSINESS = config.businessId;
const REF = 'OAUTH_CALENDAR';

function runtimeWith(resolve: () => Promise<{ value: string } | null>) {
  return { credentials: { resolve } } as never;
}
const neverCalled = runtimeWith(async () => {
  throw new Error('must not be called');
});

async function bind(status: 'live' | 'disconnected' = 'live'): Promise<void> {
  await withBusiness(BUSINESS, (db) => upsertBinding(db, {
      system: CALENDAR_SYSTEM,
      status,
      endpoint: null,
      credentialRef: REF,
      provider: 'google',
      lastOkAt: null,
      lastError: null,
    }, { by: 'test' }));
}

describe('resolveCalendarAccess', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('is not_connected when the business has no calendar binding', async () => {
    const r = await withBusiness(BUSINESS, (db) => resolveCalendarAccess(db, { runtime: neverCalled }));
    expect(r).toEqual({ unavailable: 'not_connected' });
  });

  it('is not_connected when the binding is not live', async () => {
    await bind('disconnected');
    const r = await withBusiness(BUSINESS, (db) => resolveCalendarAccess(db, { runtime: neverCalled }));
    expect(r).toEqual({ unavailable: 'not_connected' });
  });

  it('is needs_reauth when the grant was revoked, without resolving a credential', async () => {
    const key = randomBytes(32);
    await writeKeyState(key, 'KEY-test');
    await writeGrant(
      {
        businessId: BUSINESS,
        system: CALENDAR_SYSTEM,
        provider: 'google',
        credentialRef: REF,
        account: 'owner@business.example',
        scopes: ['https://www.googleapis.com/auth/calendar'],
        refreshToken: 'refresh-token-value',
        grantedBy: 'owner',
      },
      key,
    );
    await bind();
    await revokeGrant(CALENDAR_SYSTEM, BUSINESS, 'owner');
    const r = await withBusiness(BUSINESS, (db) => resolveCalendarAccess(db, { runtime: neverCalled }));
    expect(r).toEqual({ unavailable: 'needs_reauth' });
  });

  it('is credential_error when resolving the credential throws', async () => {
    await bind();
    const r = await withBusiness(BUSINESS, (db) => resolveCalendarAccess(db, {
      runtime: runtimeWith(async () => {
        throw new Error('vault down');
      }),
    }));
    expect(r).toEqual({ unavailable: 'credential_error' });
  });

  it('returns the client, token and provider when everything resolves', async () => {
    await bind();
    const r = await withBusiness(BUSINESS, (db) => resolveCalendarAccess(db, { runtime: runtimeWith(async () => ({ value: 'tok' })) }));
    expect(r).toMatchObject({ token: 'tok', provider: 'google' });
  });
});
