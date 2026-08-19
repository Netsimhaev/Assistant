import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { queryAudit } from '../audit/log.js';
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

  it('rejects an invalid binding at write time and writes nothing', async () => {
    await expect(
      upsertBinding(
        {
          system: '',
          status: 'live',
          endpoint: null,
          credentialRef: null,
          lastOkAt: null,
          lastError: null,
        },
        { businessId: BUSINESS },
      ),
    ).rejects.toThrow();

    expect(await loadBindings({ businessId: BUSINESS })).toEqual([]);
  });

  it('audits a mutation with exactly one entry naming the system', async () => {
    await upsertBinding(
      {
        system: 'office-mail',
        status: 'live',
        endpoint: null,
        credentialRef: null,
        lastOkAt: null,
        lastError: null,
      },
      { businessId: BUSINESS },
    );

    const entries = await queryAudit({ businessId: BUSINESS, kind: 'connection_binding' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reason).toContain('office-mail');
  });

  it('survives endpoint and credentialRef across a status-only change', async () => {
    const withValues = {
      system: 'office-mail',
      status: 'live' as const,
      endpoint: 'smtp.example.com:587',
      credentialRef: 'OFFICE_MAIL',
      lastOkAt: null,
      lastError: null,
    };
    await upsertBinding(withValues, { businessId: BUSINESS });
    await upsertBinding({ ...withValues, status: 'error', lastError: 'auth failed' }, {
      businessId: BUSINESS,
    });

    const bindings = await loadBindings({ businessId: BUSINESS });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.status).toBe('error');
    expect(bindings[0]?.endpoint).toBe('smtp.example.com:587');
    expect(bindings[0]?.credentialRef).toBe('OFFICE_MAIL');
  });
});
