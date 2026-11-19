/**
 * The named cross-business operations of `platform.ts` (spec §5.7). The list
 * is closed: every export runs past the row-level wall, so a new one is a
 * deliberate change made here, never a convenience.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { registerBusiness, resetDatabase } from '../test/db.js';
import * as platform from './platform.js';
import { resolveBusinessForHook } from './platform.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('platform.ts', () => {
  it('exports exactly the frozen list of operations — a new one is a deliberate change', () => {
    expect(Object.keys(platform).sort()).toEqual(
      [
        'closePlatform',
        'listActiveBusinesses',
        'resolveLogin',
        'cleanupOAuthStates',
        'verifyServerKeyState',
        'resolveBusinessForHook',
      ].sort(),
    );
  });
});

describe('resolveBusinessForHook', () => {
  it('returns only whether a registered business is active', async () => {
    await registerBusiness('hook-active');
    await registerBusiness('hook-paused', 'suspended');
    expect(await resolveBusinessForHook('hook-active')).toEqual({ active: true });
    expect(await resolveBusinessForHook('hook-paused')).toEqual({ active: false });
  });

  it('is null for an unknown, malformed or reserved id', async () => {
    expect(await resolveBusinessForHook('nobody-here')).toBeNull();
    expect(await resolveBusinessForHook('BAD_ID')).toBeNull();
    expect(await resolveBusinessForHook('produced')).toBeNull();
    expect(await resolveBusinessForHook("x'; --")).toBeNull();
  });
});
