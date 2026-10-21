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
      provider: null,
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

  /**
   * Final fix wave, item 8. Before this fix nothing ever deleted from this
   * table: every ceremony start left a row behind forever, consumed or not,
   * each one holding a `code_verifier` in plaintext. Pruning is
   * opportunistic — it runs inside `createState` itself, not a scheduler
   * pass — so the positive half below (dead rows genuinely present right up
   * until the next start) matters: it is what proves the next `createState`
   * call is actually what triggers the cleanup, not something that would
   * have been empty regardless.
   */
  it('prunes consumed and expired rows the next time a ceremony starts, and leaves live ones alone', async () => {
    // Both rows are minted BEFORE either becomes dead, and neither is
    // touched by a THIRD `createState` call until after the "before" check
    // below — `createState` itself prunes opportunistically on every call
    // (see `pruneStaleStates`'s own docblock), so minting the "expired" row
    // only after consuming the first one would have pruned the first one
    // right then, and the "before" snapshot would never see it.
    const consumed = await createState({
      businessId: BUSINESS,
      system: 'office-calendar',
      sessionId: 's1',
      codeVerifier: 'v1',
    });
    const expired = await createState({
      businessId: OTHER_BUSINESS,
      system: 'office-mail',
      sessionId: 's2',
      codeVerifier: 'v2',
    });

    await consumeState(consumed, BUSINESS);
    await getPool().query(
      `UPDATE oauth_states SET expires_at = now() - interval '1 minute' WHERE state = $1`,
      [expired],
    );

    // Positive half: both dead rows genuinely still exist right before the
    // next ceremony start — pruning is not something SQLite/Postgres did on
    // its own, and the assertions below are not vacuously true.
    const before = await getPool().query<{ n: string }>('SELECT count(*)::text AS n FROM oauth_states');
    expect(before.rows[0]?.n).toBe('2');

    // A third, still-live ceremony starting is what triggers the prune.
    // Unscoped by business id on purpose (see `pruneStaleStates`'s own
    // docblock): the expired row belongs to `OTHER_BUSINESS`, and this call
    // is made under `BUSINESS` — it must still be swept.
    const live = await createState({
      businessId: BUSINESS,
      system: 'office-calendar',
      sessionId: 's3',
      codeVerifier: 'v3',
    });

    const remaining = await getPool().query<{ state: string }>('SELECT state FROM oauth_states');
    const remainingStates = remaining.rows.map((r) => r.state);
    expect(remainingStates).not.toContain(consumed);
    expect(remainingStates).not.toContain(expired);
    expect(remainingStates).toEqual([live]);
  });
});
