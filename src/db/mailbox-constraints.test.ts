/**
 * Migration 045: the database refuses an oauth_states provider outside the
 * closed set, and the two mail_messages lookups that run on every gate check
 * and every poll have an index.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from './pool.js';
import { resetDatabase } from '../test/db.js';
import { createState } from '../governance/oauth-state.js';

const BUSINESS = 'test-business';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('oauth_states.provider is a closed set', () => {
  it('accepts google, microsoft and NULL (a calendar ceremony has no provider choice)', async () => {
    for (const provider of ['google', 'microsoft', undefined]) {
      await createState({
        businessId: BUSINESS,
        system: provider === undefined ? 'office-calendar' : 'mailbox',
        sessionId: 's1',
        codeVerifier: 'v1',
        ...(provider !== undefined ? { provider } : {}),
      });
    }
    const { rows } = await getPool().query<{ n: string }>('SELECT count(*)::text AS n FROM oauth_states');
    expect(rows[0]?.n).toBe('3');
  });

  it('refuses any other provider at the database, whatever the caller', async () => {
    await expect(
      createState({ businessId: BUSINESS, system: 'mailbox', sessionId: 's1', codeVerifier: 'v1', provider: 'yahoo' }),
    ).rejects.toThrow(/oauth_states_provider_known/);
  });
});

describe('mail_messages lookup indexes', () => {
  async function indexDef(name: string): Promise<string | undefined> {
    const { rows } = await getPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'mail_messages' AND indexname = $1`,
      [name],
    );
    return rows[0]?.indexdef;
  }

  it('indexes (business_id, reply_job_id) for the reply-job marker, partial on a linked job', async () => {
    const def = await indexDef('mail_messages_reply_job_idx');
    expect(def).toMatch(/\(business_id, reply_job_id\)/);
    expect(def).toMatch(/WHERE \(reply_job_id IS NOT NULL\)/);
  });

  it('indexes (business_id, job_id) for the triage-job lookup', async () => {
    expect(await indexDef('mail_messages_job_idx')).toMatch(/\(business_id, job_id\)/);
  });
});
