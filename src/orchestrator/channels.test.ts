import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { queryAudit } from '../audit/log.js';
import { resetDatabase } from '../test/db.js';
import { loadBindings, upsertBinding } from './bindings.js';
import { buildCharter } from '../test/fixtures.js';
import { compileCharter } from '../charter/compile.js';
import type { CharterConnection } from '../domain/connection.js';
import { deriveTargetId, resolveChannel } from './channels.js';
import { ActionClass, addresseeOf } from '../domain/action.js';
import { buildFacts, type FactsContext } from '../policy/facts.js';

const BUSINESS = 'test-business';
const BY = 'net.simhaev@gmail.com';

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

  it('rejects an empty "by" and writes nothing', async () => {
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
        { businessId: BUSINESS, by: '' },
      ),
    ).rejects.toThrow();

    expect(await loadBindings({ businessId: BUSINESS })).toEqual([]);
  });

  it('keeps the audit append inside the same transaction as the write', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      await upsertBinding(
        {
          system: 'office-mail',
          status: 'live',
          endpoint: null,
          credentialRef: null,
          lastOkAt: null,
          lastError: null,
        },
        { businessId: BUSINESS, by: BY, db: client },
      );

      // Force this transaction to abort *after* the write and the audit
      // append have both run, then roll it back. If the append shares this
      // transaction — the property this test exists to protect — the
      // rollback undoes the binding row and the audit row together. If the
      // append instead ran on its own connection (the round-1/round-2
      // regression), it already committed independently and survives this
      // rollback, and only the audit assertion below fails.
      await expect(client.query('SELECT 1/0')).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

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

function conn(over: Partial<CharterConnection> = {}): CharterConnection {
  return {
    system: 'office-mail',
    label: 'תיבת המשרד',
    channel: 'api',
    serves: ['mail.send'],
    target: null,
    subprocessor: null,
    ...over,
  };
}

function bundleWith(connections: CharterConnection[]) {
  return compileCharter(buildCharter({ connections }));
}

const LIVE = {
  system: 'office-mail',
  status: 'live' as const,
  endpoint: null,
  credentialRef: null,
  lastOkAt: null,
  lastError: null,
};

describe('resolving a channel', () => {
  it('resolves a tool to the system that serves it', () => {
    const result = resolveChannel(bundleWith([conn()]), [LIVE], 'mail.send', null);
    expect(result).toEqual({ status: 'resolved', system: 'office-mail', channel: 'api' });
  });

  it('prefers an exact target over the catch-all', () => {
    const bundle = bundleWith([
      conn({ system: 'generic', serves: ['browser.submit_order'], target: null }),
      conn({
        system: 'supplier-a-api',
        serves: ['browser.submit_order'],
        target: 'supplier-a',
      }),
    ]);
    const bindings = [
      { ...LIVE, system: 'generic' },
      { ...LIVE, system: 'supplier-a-api' },
    ];

    const result = resolveChannel(bundle, bindings, 'browser.submit_order', 'supplier-a');
    expect(result).toEqual({
      status: 'resolved',
      system: 'supplier-a-api',
      channel: 'api',
    });
  });

  it('refuses when two connections match at the same specificity', () => {
    // Charter signing now rejects two connections serving the same tool for
    // the same target (including two catch-alls) as an authoring mistake —
    // src/domain/charter.ts's superRefine. That guards signing time. This
    // resolver defends the same shape at a different moment: a bundle that
    // reached it without going through that gate (an older signed charter,
    // a hand-built bundle in a test, a future bypass). Build the bundle
    // through the normal path, then graft on the ambiguous pair directly so
    // the signing check never sees it.
    const bundle = bundleWith([conn({ system: 'mail-a' })]);
    const ambiguous = {
      ...bundle,
      connections: [conn({ system: 'mail-a' }), conn({ system: 'mail-b' })],
    };
    const bindings = [
      { ...LIVE, system: 'mail-a' },
      { ...LIVE, system: 'mail-b' },
    ];

    // Array order deciding between two policies looks like a decision and
    // behaves like an accident.
    const result = resolveChannel(ambiguous, bindings, 'mail.send', null);
    expect(result.status).toBe('ambiguous');
  });

  it('refuses a tool no connection serves', () => {
    const result = resolveChannel(bundleWith([conn()]), [LIVE], 'crm.write', null);
    expect(result.status).toBe('no_channel');
  });

  it('reports a permitted connection with no live binding as unavailable', () => {
    const result = resolveChannel(bundleWith([conn()]), [], 'mail.send', null);
    expect(result).toEqual({
      status: 'unavailable',
      system: 'office-mail',
      reason: 'no binding',
    });
  });

  it('reports a disconnected binding as unavailable, not resolved', () => {
    const result = resolveChannel(
      bundleWith([conn()]),
      [{ ...LIVE, status: 'disconnected' }],
      'mail.send',
      null,
    );
    expect(result.status).toBe('unavailable');
  });

  const FACTS_CTX: FactsContext = { provenance: 'boss', chainDepth: 0, counterpartyTags: [] };

  describe('deriveTargetId agrees with buildFacts', () => {
    // Driving both functions over one case table is the only form of this
    // test that can detect drift between them — a hardcoded expectation on
    // each side can be wrong in the same way on both sides at once and still
    // pass. `mail.send` refines to an email class, which resolves by
    // counterparty (see the routing tests below), so the counterparty half
    // is what both functions are compared on here.
    const cases: [string, Record<string, unknown>][] = [
      ['entityId only', { entityId: 'c_812' }],
      ['counterpartyId only', { counterpartyId: 'c_900' }],
      ['counterpartyId and entityId together', { counterpartyId: 'c_900', entityId: 'c_812' }],
      ['neither', { body: 'hello' }],
    ];

    it.each(cases)('%s', (_label, input) => {
      const facts = buildFacts('mail.send', input, FACTS_CTX);
      const result = deriveTargetId(input, facts.actionClass);
      expect(result).toBe(facts.counterpartyId);
    });
  });

  describe('the routing tie-break follows addresseeOf, not one literal class', () => {
    // The tie-break reads domain/action.ts's addresseeOf; it does not restate
    // it. A class that reaches a person is the class whose counterpartyId
    // names the party being dealt with — so person wins the counterparty, and
    // everything else (supplier, site, internal system, or a call we could not
    // classify) resolves by supplier.
    //
    // These cases are the boundary the previous rounds got wrong. Keying on
    // the literal `purchase.place` left browser.interact, browser.session and
    // a null class routing by counterparty, which let a stray or injected
    // counterpartyId steer a supplier-side browser step.
    const BOTH = { supplierId: 'supplier-a', counterpartyId: 'c_812' };

    const cases: [ActionClass | null, string][] = [
      ['browser.interact', 'supplier-a'],
      ['browser.session', 'supplier-a'],
      [null, 'supplier-a'],
      ['purchase.place', 'supplier-a'],
      ['email.initiate', 'c_812'],
      ['payment.make', 'c_812'],
    ];

    it.each(cases)('%s with both ids resolves to %s', (actionClass, expected) => {
      expect(deriveTargetId(BOTH, actionClass)).toBe(expected);
    });

    // The same six decisions again, but reached through the real classifier
    // rather than a literal class, because the defect lived in the gap
    // between a tool name and the class it lands on: browser.click carrying
    // no amount stays browser.interact and only refines to purchase.place
    // once amountMinor > 0.
    it('routes an unpriced browser.click to the supplier', () => {
      const facts = buildFacts('browser.click', BOTH, FACTS_CTX);
      expect(facts.actionClass).toBe('browser.interact');
      expect(deriveTargetId(BOTH, facts.actionClass)).toBe('supplier-a');
    });

    it('routes a priced browser.click to the supplier as well', () => {
      const priced = { ...BOTH, amountMinor: 5000 };
      const facts = buildFacts('browser.click', priced, FACTS_CTX);
      expect(facts.actionClass).toBe('purchase.place');
      expect(deriveTargetId(priced, facts.actionClass)).toBe('supplier-a');
    });

    it('routes a browser session request to the supplier', () => {
      const facts = buildFacts('credential.request_session', BOTH, FACTS_CTX);
      expect(facts.actionClass).toBe('browser.session');
      expect(deriveTargetId(BOTH, facts.actionClass)).toBe('supplier-a');
    });

    it('routes browser.submit_order to the supplier', () => {
      const facts = buildFacts('browser.submit_order', BOTH, FACTS_CTX);
      expect(facts.actionClass).toBe('purchase.place');
      expect(deriveTargetId(BOTH, facts.actionClass)).toBe('supplier-a');
    });

    it('routes mail.send to the counterparty despite a stray supplierId', () => {
      const facts = buildFacts('mail.send', BOTH, FACTS_CTX);
      expect(addresseeOf(facts.actionClass!)).toBe('person');
      expect(deriveTargetId(BOTH, facts.actionClass)).toBe('c_812');
    });

    it('routes whatsapp to the counterparty despite a stray supplierId', () => {
      const facts = buildFacts('wa.send_message', BOTH, FACTS_CTX);
      expect(addresseeOf(facts.actionClass!)).toBe('person');
      expect(deriveTargetId(BOTH, facts.actionClass)).toBe('c_812');
    });

    // Every class in the enum agrees with addresseeOf, so a class added later
    // cannot land on a routing rule nobody chose for it.
    it.each(ActionClass.options)('%s routes by its addressee', (cls) => {
      const expected = addresseeOf(cls) === 'person' ? 'c_812' : 'supplier-a';
      expect(deriveTargetId(BOTH, cls)).toBe(expected);
    });
  });

  it('treats an empty-string field as absent', () => {
    expect(deriveTargetId({ supplierId: '' }, null)).toBeNull();
    expect(deriveTargetId({ body: 'hello' }, null)).toBeNull();
  });
});
