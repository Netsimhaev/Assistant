import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { loadBindings, upsertBinding } from './bindings.js';

const BUSINESS = 'test-business';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('connection bindings', () => {
  it('stores a binding and reads it back', async () => {
    await upsertBinding(
      {
        system: 'office-mail',
        status: 'live',
        endpoint: 'smtp.example.com:587',
        credentialRef: 'OFFICE_MAIL',
        lastOkAt: null,
        lastError: null,
      },
      { businessId: BUSINESS },
    );

    const bindings = await loadBindings({ businessId: BUSINESS });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.status).toBe('live');
    expect(bindings[0]?.credentialRef).toBe('OFFICE_MAIL');
  });

  it('replaces a binding for the same system rather than duplicating it', async () => {
    const base = {
      system: 'office-mail',
      status: 'live' as const,
      endpoint: null,
      credentialRef: null,
      lastOkAt: null,
      lastError: null,
    };
    await upsertBinding(base, { businessId: BUSINESS });
    await upsertBinding({ ...base, status: 'error', lastError: 'auth failed' }, {
      businessId: BUSINESS,
    });

    const bindings = await loadBindings({ businessId: BUSINESS });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.status).toBe('error');
  });

  it('keeps one business out of another business bindings', async () => {
    await upsertBinding(
      {
        system: 'office-mail',
        status: 'live',
        endpoint: null,
        credentialRef: null,
        lastOkAt: null,
        lastError: null,
      },
      { businessId: 'other-business' },
    );
    expect(await loadBindings({ businessId: BUSINESS })).toEqual([]);
  });
});
