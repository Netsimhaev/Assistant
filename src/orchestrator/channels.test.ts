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
        provider: null,
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
        provider: null,
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
      provider: null,
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
        provider: null,
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
          provider: null,
          lastOkAt: null,
          lastError: null,
        },
        { businessId: BUSINESS, by: BY },
      ),
    ).rejects.toThrow();

    expect(await loadBindings({ businessId: BUSINESS })).toEqual([]);
  });

  it('rejects a malformed credentialRef at write time and writes nothing', async () => {
    // A credentialRef must match CREDENTIAL_REF_PATTERN (uppercase letters,
    // digits, underscores) so a misspelled ref -- lower-case, hyphenated,
    // whatever envCredentials.resolve would silently refuse at execution --
    // is caught here, at configuration time, instead of reading as
    // credentialled and failing later with nothing distinguishing "the ref
    // is misspelled" from "the environment variable is missing".
    await expect(
      upsertBinding(
        {
          system: 'office-mail',
          status: 'live',
          endpoint: null,
          credentialRef: 'sendgrid-api',
          provider: null,
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
        provider: null,
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
          provider: null,
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
          provider: null,
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
        provider: null,
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
  provider: null,
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
    // test that can detect drift between them - a hardcoded expectation on
    // each side can be wrong in the same way on both sides at once and still
    // pass.
    //
    // Both tools here resolve by counterparty, which is the half that has to
    // agree: `mail.send` refines to an email class (addressee `person`) and
    // `crm.write` is `internal`. The internal classes are in this table on
    // purpose - when the rule read "not a person therefore supplier", they
    // routed by a stray `supplierId` and this agreement broke.
    const cases: [string, string, Record<string, unknown>][] = [
      ['mail.send', 'entityId only', { entityId: 'c_812' }],
      ['mail.send', 'counterpartyId only', { counterpartyId: 'c_900' }],
      [
        'mail.send',
        'counterpartyId and entityId together',
        { counterpartyId: 'c_900', entityId: 'c_812' },
      ],
      ['mail.send', 'neither', { body: 'hello' }],
      ['mail.send', 'a stray supplierId alongside', { counterpartyId: 'c_900', supplierId: 's_1' }],
      ['crm.write', 'entityId only', { entityId: 'c_812' }],
      ['crm.write', 'a stray supplierId alongside', { counterpartyId: 'c_900', supplierId: 's_1' }],
      ['accounting.write', 'a stray supplierId alongside', { entityId: 'c_812', supplierId: 's_1' }],
      ['data.export', 'a stray supplierId alongside', { entityId: 'c_812', supplierId: 's_1' }],
      ['file.write', 'a stray supplierId alongside', { entityId: 'c_812', supplierId: 's_1' }],
      // The rows that matter most, and the ones whose absence let the
      // cross-fallback survive five rounds: a single id, on the side that
      // loses. The precedence rule never had to be beaten - a payload could
      // just omit the field it would have lost with, and the surviving id
      // became the target by default. Both of these must now agree with
      // buildFacts reporting no counterparty at all.
      ['mail.send', 'a supplierId and no counterparty', { to: 'victim@example.com', supplierId: 'evil-co' }],
      ['crm.write', 'a supplierId and no counterparty', { supplierId: 'evil-co', note: 'hi' }],
      ['accounting.write', 'a supplierId and no counterparty', { supplierId: 'evil-co' }],
    ];

    it.each(cases)('%s, %s', (toolName, _label, input) => {
      const facts = buildFacts(toolName, input, FACTS_CTX);
      const result = deriveTargetId(toolName, input, facts.actionClass);
      expect(result).toBe(facts.counterpartyId);
    });
  });

  describe('the routing tie-break', () => {
    // Supplier precedence is a closed list of three: addressee `browser`,
    // `purchase.place`, and a null class on a `browser.` tool. Everything
    // else - every `person` class and every `internal` class - resolves by
    // counterparty.
    //
    // Both directions of this boundary have been wrong here before. Keying on
    // the literal `purchase.place` left an unpriced browser click routing by
    // counterparty; widening it to "anything not addressed to a person"
    // handed the internal systems of record to a stray supplierId.
    const BOTH = { supplierId: 'supplier-a', counterpartyId: 'c_812' };

    const cases: { label: string; tool: string; cls: ActionClass | null; expected: string }[] = [
      { label: 'a browser click', tool: 'browser.click', cls: 'browser.interact', expected: 'supplier-a' },
      { label: 'a session request', tool: 'credential.request_session', cls: 'browser.session', expected: 'supplier-a' },
      { label: 'an unclassified browser call', tool: 'browser.navigate', cls: null, expected: 'supplier-a' },
      { label: 'a purchase', tool: 'browser.submit_order', cls: 'purchase.place', expected: 'supplier-a' },
      { label: 'a first-contact email', tool: 'mail.send', cls: 'email.initiate', expected: 'c_812' },
      { label: 'a payment', tool: 'payment.charge', cls: 'payment.make', expected: 'c_812' },
    ];

    // Named-property cases, so a failure names the case and the id that should
    // have won rather than printing two positional %s that do not line up.
    it.each(cases)('$label with both ids resolves to $expected', ({ tool, cls, expected }) => {
      expect(deriveTargetId(tool, BOTH, cls)).toBe(expected);
    });

    // The losing side yields null rather than falling through to the other
    // id. Without this, a payload skipped the precedence argument entirely by
    // supplying only the field it wanted honoured.
    it('yields no target when only the losing id is present', () => {
      // Supplier-preferring call carrying only a counterparty.
      expect(deriveTargetId('browser.click', { counterpartyId: 'c_812' }, 'browser.interact')).toBe(
        null,
      );
      expect(deriveTargetId('browser.navigate', { counterpartyId: 'c_812' }, null)).toBe(null);
      expect(
        deriveTargetId('browser.submit_order', { entityId: 'c_812' }, 'purchase.place'),
      ).toBe(null);
      // Counterparty-preferring call carrying only a supplier.
      expect(
        deriveTargetId('mail.send', { to: 'victim@example.com', supplierId: 'evil-co' }, 'email.initiate'),
      ).toBe(null);
      expect(deriveTargetId('crm.write', { supplierId: 'evil-co' }, 'crm.write')).toBe(null);
    });

    // The mirror of the null case above. `null` alone must not buy supplier
    // precedence - only `null` on a browser tool does.
    it('routes an unclassified non-browser call to the counterparty', () => {
      expect(deriveTargetId('mail.draft', BOTH, null)).toBe('c_812');
      expect(deriveTargetId('memory.recall', BOTH, null)).toBe('c_812');
    });

    // The same decisions again, but reached through the real classifier
    // rather than a literal class, because the defect lived in the gap
    // between a tool name and the class it lands on: browser.click carrying
    // no amount stays browser.interact and only refines to purchase.place
    // once amountMinor > 0.
    it('routes an unpriced browser.click to the supplier', () => {
      const facts = buildFacts('browser.click', BOTH, FACTS_CTX);
      expect(facts.actionClass).toBe('browser.interact');
      expect(deriveTargetId('browser.click', BOTH, facts.actionClass)).toBe('supplier-a');
    });

    it('routes a priced browser.click to the supplier as well', () => {
      const priced = { ...BOTH, amountMinor: 5000 };
      const facts = buildFacts('browser.click', priced, FACTS_CTX);
      expect(facts.actionClass).toBe('purchase.place');
      expect(deriveTargetId('browser.click', priced, facts.actionClass)).toBe('supplier-a');
    });

    it('routes a browser session request to the supplier', () => {
      const facts = buildFacts('credential.request_session', BOTH, FACTS_CTX);
      expect(facts.actionClass).toBe('browser.session');
      expect(deriveTargetId('credential.request_session', BOTH, facts.actionClass)).toBe(
        'supplier-a',
      );
    });

    it('routes browser.submit_order to the supplier', () => {
      const facts = buildFacts('browser.submit_order', BOTH, FACTS_CTX);
      expect(facts.actionClass).toBe('purchase.place');
      expect(deriveTargetId('browser.submit_order', BOTH, facts.actionClass)).toBe('supplier-a');
    });

    it('routes mail.send to the counterparty despite a stray supplierId', () => {
      const facts = buildFacts('mail.send', BOTH, FACTS_CTX);
      expect(addresseeOf(facts.actionClass!)).toBe('person');
      expect(deriveTargetId('mail.send', BOTH, facts.actionClass)).toBe('c_812');
    });

    it('routes whatsapp to the counterparty despite a stray supplierId', () => {
      const facts = buildFacts('wa.send_message', BOTH, FACTS_CTX);
      expect(addresseeOf(facts.actionClass!)).toBe('person');
      expect(deriveTargetId('wa.send_message', BOTH, facts.actionClass)).toBe('c_812');
    });

    it('routes a CRM write to the counterparty despite a stray supplierId', () => {
      const facts = buildFacts('crm.write', BOTH, FACTS_CTX);
      expect(addresseeOf(facts.actionClass!)).toBe('internal');
      expect(deriveTargetId('crm.write', BOTH, facts.actionClass)).toBe('c_812');
    });

    /**
     * Every class in the enum, written out.
     *
     * The expectation is a literal table and not `addresseeOf(cls) === ... ?`,
     * because a computed expectation calls the same function the
     * implementation calls: reclassifying a class would move both sides
     * together and this test would stay green while claiming to be the thing
     * that stops exactly that. Only literals pin anything.
     *
     * A `Record<ActionClass, string>` rather than a list, so a class added to
     * the enum is a compile error here instead of a class with no pinned
     * routing.
     *
     * The tool name is held constant and deliberately not a `browser.` one,
     * so this table measures the class rule alone; the prefix rule for a null
     * class is covered by its own cases above.
     */
    const ROUTES_TO: Record<ActionClass, string> = {
      'email.reply': 'c_812',
      'email.initiate': 'c_812',
      'whatsapp.reply': 'c_812',
      'whatsapp.initiate': 'c_812',
      'calendar.create': 'c_812',
      'calendar.move': 'c_812',
      'calendar.cancel': 'c_812',
      'quote.issue': 'c_812',
      'discount.grant': 'c_812',
      'commitment.make': 'c_812',
      'purchase.place': 'supplier-a',
      'payment.make': 'c_812',
      'refund.issue': 'c_812',
      'crm.write': 'c_812',
      'accounting.write': 'c_812',
      'artifact.write': 'c_812',
      'doc.deliver': 'c_812',
      'media.publish': 'c_812',
      'browser.interact': 'supplier-a',
      'browser.session': 'supplier-a',
      'contract.sign': 'c_812',
      'data.export': 'c_812',
      'memory.write_longterm': 'c_812',
      'charter.amend': 'c_812',
      'agent.delegate': 'c_812',
    };

    it.each(ActionClass.options)('%s routes to its pinned target', (cls) => {
      expect(deriveTargetId('some.tool', BOTH, cls)).toBe(ROUTES_TO[cls]);
    });
  });

  it('treats an empty-string field as absent', () => {
    expect(deriveTargetId('browser.navigate', { supplierId: '' }, null)).toBeNull();
    expect(deriveTargetId('mail.send', { body: 'hello' }, null)).toBeNull();
  });
});
