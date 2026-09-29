import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { consumeState, createState } from './oauth-state.js';

const BUSINESS = 'test-business';
const OTHER_BUSINESS = 'other-business';

describe('oauth-state: the anti-forgery gate for the consent ceremony', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('consumes a state exactly once', async () => {
    const state = await createState({
      businessId: BUSINESS,
      system: 'office-calendar',
      sessionId: 's1',
      codeVerifier: 'v1',
    });
    expect((await consumeState(state, BUSINESS))?.system).toBe('office-calendar');
    expect(await consumeState(state, BUSINESS)).toBeNull();
  });

  it('returns the session id and code verifier it was created with', async () => {
    const state = await createState({
      businessId: BUSINESS,
      system: 'office-calendar',
      sessionId: 'session-abc',
      codeVerifier: 'verifier-xyz',
    });
    expect(await consumeState(state, BUSINESS)).toEqual({
      system: 'office-calendar',
      sessionId: 'session-abc',
      codeVerifier: 'verifier-xyz',
    });
  });

  it('refuses a state from another business, and an expired one', async () => {
    const state = await createState({
      businessId: BUSINESS,
      system: 'office-calendar',
      sessionId: 's1',
      codeVerifier: 'v1',
    });
    expect(await consumeState(state, OTHER_BUSINESS)).toBeNull();
    // The wrong-business attempt above must not have consumed it either --
    // otherwise a probe from any business would burn every other business's
    // states, a denial-of-service against the ceremony itself.
    await getPool().query(`UPDATE oauth_states SET expires_at = now() - interval '1 minute'`);
    expect(await consumeState(state, BUSINESS)).toBeNull();
  });

  it('never resolves a nonexistent state', async () => {
    expect(await consumeState('this-state-was-never-created', BUSINESS)).toBeNull();
  });

  it('mints a distinct state on every call, even for the same input', async () => {
    const a = await createState({ businessId: BUSINESS, system: 'office-calendar', sessionId: 's1', codeVerifier: 'v1' });
    const b = await createState({ businessId: BUSINESS, system: 'office-calendar', sessionId: 's1', codeVerifier: 'v1' });
    expect(a).not.toBe(b);
  });
});
