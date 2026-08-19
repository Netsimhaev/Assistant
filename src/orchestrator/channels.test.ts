import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool } from '../db/pool.js';
import * as auditLog from '../audit/log.js';
import { queryAudit } from '../audit/log.js';
import { resetDatabase } from '../test/db.js';
import { loadBindings, upsertBinding } from './bindings.js';

const BUSINESS = 'test-business';
const BY = 'net.simhaev@gmail.com';

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
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
      { businessId: BUSINESS, by: BY },
    );

    const bindings = await loadBindings({ businessId: BUSINESS });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.status).toBe('live');
    expect(bindings[0]?.credentialRef).toBe('OFFICE_MAIL');
  });

  it('reads back a non-null lastOkAt as an ISO string', async () => {
    const lastOkAt = '2026-08-19T08:00:00.000Z';
    await upsertBinding(
      {
        system: 'office-mail',
        status: 'live',
        endpoint: null,
        credentialRef: null,
        lastOkAt,
        lastError: null,
      },
      { businessId: BUSINESS, by: BY },
    );

    const bindings = await loadBindings({ businessId: BUSINESS });
    expect(bindings[0]?.lastOkAt).toBe(lastOkAt);
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
    await upsertBinding(base, { businessId: BUSINESS, by: BY });
    await upsertBinding({ ...base, status: 'error', lastError: 'auth failed' }, {
      businessId: BUSINESS,
      by: BY,
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
      { businessId: 'other-business', by: BY },
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
        { businessId: BUSINESS, by: BY },
      ),
    ).rejects.toThrow();

    expect(await loadBindings({ businessId: BUSINESS })).toEqual([]);
  });

  it('audits a mutation with exactly one entry naming the system and the actor', async () => {
    await upsertBinding(
      {
        system: 'office-mail',
        status: 'live',
        endpoint: null,
        credentialRef: null,
        lastOkAt: null,
        lastError: null,
      },
      { businessId: BUSINESS, by: BY },
    );

    const entries = await queryAudit({ businessId: BUSINESS, kind: 'connection_binding' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reason).toContain('office-mail');
    expect(entries[0]?.onBehalfOf).toBe(BY);
  });

  it('rolls back the binding write when the audit append fails', async () => {
    vi.spyOn(auditLog, 'appendAudit').mockRejectedValueOnce(new Error('audit append failed'));

    await expect(
      upsertBinding(
        {
          system: 'office-mail',
          status: 'live',
          endpoint: null,
          credentialRef: null,
          lastOkAt: null,
          lastError: null,
        },
        { businessId: BUSINESS, by: BY },
      ),
    ).rejects.toThrow('audit append failed');

    expect(await loadBindings({ businessId: BUSINESS })).toEqual([]);
    expect(await queryAudit({ businessId: BUSINESS, kind: 'connection_binding' })).toEqual([]);
  });

  it('preserves endpoint and credentialRef across a read-modify-write status change', async () => {
    await upsertBinding(
      {
        system: 'office-mail',
        status: 'live',
        endpoint: 'smtp.example.com:587',
        credentialRef: 'OFFICE_MAIL',
        lastOkAt: null,
        lastError: null,
      },
      { businessId: BUSINESS, by: BY },
    );

    // Real read-modify-write: load the current row, change only `status`, and
    // write the whole thing back — `upsertBinding` has no partial-update path,
    // so any test that re-supplies the same endpoint/credentialRef proves
    // nothing about whether they were preserved by the code under test.
    const before = await loadBindings({ businessId: BUSINESS });
    const current = before[0];
    if (current === undefined) throw new Error('expected a binding to exist');

    await upsertBinding(
      { ...current, status: 'error', lastError: 'auth failed' },
      { businessId: BUSINESS, by: BY },
    );

    const after = await loadBindings({ businessId: BUSINESS });
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe('error');
    expect(after[0]?.endpoint).toBe('smtp.example.com:587');
    expect(after[0]?.credentialRef).toBe('OFFICE_MAIL');
  });
});
