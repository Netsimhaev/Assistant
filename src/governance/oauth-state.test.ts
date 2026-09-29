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

  it('refuses a state from another business, WITHOUT consuming it', async () => {
    const state = await createState({
      businessId: BUSINESS,
      system: 'office-calendar',
      sessionId: 's1',
      codeVerifier: 'v1',
    });
    expect(await consumeState(state, OTHER_BUSINESS)).toBeNull();
    // The load-bearing half of this test: an implementation that filtered
    // by `business_id` in JavaScript instead of in the `WHERE` clause (or
    // dropped it from the predicate entirely and only checked it on the
    // returned row) would ALSO return `null` above -- but it would have
    // already consumed the row doing so, which `consumeState`'s own
    // docblock names as exactly the alternative shape it rejects. Proving
    // the wrong-business attempt refuses is not enough; it must refuse
    // *without spending the state*, or a probe from any business would burn
    // every other business's states -- a denial-of-service against the
    // ceremony itself. The correct business must still be able to consume it.
    expect((await consumeState(state, BUSINESS))?.system).toBe('office-calendar');
  });

  it('refuses an expired state', async () => {
    const state = await createState({
      businessId: BUSINESS,
      system: 'office-calendar',
      sessionId: 's1',
      codeVerifier: 'v1',
    });
    await getPool().query(`UPDATE oauth_states SET expires_at = now() - interval '1 minute' WHERE state = $1`, [
      state,
    ]);
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
