import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { resolveCalendarAccess } from './client-for.js';

const runtime = {
  credentials: {
    async resolve() {
      throw new Error('must not be called');
    },
  },
} as never;

describe('resolveCalendarAccess', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('is not_connected when the business has no calendar binding', async () => {
    const r = await resolveCalendarAccess({ businessId: config.businessId, runtime });
    expect(r).toEqual({ unavailable: 'not_connected' });
  });
});
