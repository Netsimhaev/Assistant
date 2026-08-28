import { describe, expect, it } from 'vitest';
import { compileCharter } from './compile.js';
import { signCharter } from './sign.js';
import { buildCharter } from '../test/fixtures.js';
import { BusinessCharter, CharterCounterparty } from '../domain/charter.js';
import type { BusinessCharter as Charter } from '../domain/charter.js';

/**
 * The charter compiler builds lookup tables keyed by strings the owner wrote —
 * counterparty ids, tags, supplier ids. Two of those writes were unguarded
 * object-literal accesses, and `__proto__` is a string an owner can type:
 *
 *  - `bucket[key] ?? {}` returns `Object.prototype` rather than `undefined`,
 *    and the loop that follows writes onto it. That is process-wide pollution,
 *    and no `Object.hasOwn` on the payload side can see it: the polluted
 *    property is inherited by the *lookup table*, not owned by any payload.
 *  - `approvedSupplierCeilingMinor[entityId] = <number>` with that same key is
 *    a silent no-op — assigning a primitive to `__proto__` does nothing — so a
 *    ceiling the owner signed simply never applies, and nothing says so.
 *
 * Refused at signing, and refused again by the compiler. The schema is the
 * layer the owner is actually told about; the compiler check is what holds if
 * a charter reaches it some other way, which is exactly what an applied
 * amendment does.
 */
const DANGEROUS = ['__proto__', 'constructor', 'prototype'] as const;

function counterparty(field: 'entityId' | 'tag', key: string) {
  return {
    match: { [field]: key },
    label: 'זדוני',
    trust: 'unknown_external' as const,
    autonomyOverrides: { 'email.reply': 'draft_only' as const },
    doNotContact: false,
    notes: '',
  };
}

/** Modified AND re-signed, so the compiler's signature check is not what fails. */
function signedCharterWithTag(key: string): Charter {
  const base = buildCharter();
  const { signature: _dropped, ...unsigned } = base;
  return signCharter(
    { ...unsigned, counterparties: [...base.counterparties, counterparty('tag', key)] },
    { signedByPersonId: 'owner', method: 'dashboard_click' },
  );
}

describe('charter keys that are not safe to use as object keys', () => {
  it.each(DANGEROUS)('the counterparty schema rejects %s as an entity id', (key) => {
    expect(CharterCounterparty.safeParse(counterparty('entityId', key)).success).toBe(false);
  });

  it.each(DANGEROUS)('the counterparty schema rejects %s as a tag', (key) => {
    expect(CharterCounterparty.safeParse(counterparty('tag', key)).success).toBe(false);
  });

  it.each(DANGEROUS)('the charter schema rejects %s as an approved supplier id', (key) => {
    const base = buildCharter();
    const withSupplier = {
      ...base,
      money: {
        ...base.money,
        approvedSuppliers: [{ entityId: key, categories: [], autoOrderCeilingMinor: 1000 }],
      },
    };
    expect(BusinessCharter.safeParse(withSupplier).success).toBe(false);
  });

  it('still accepts an ordinary tag', () => {
    expect(CharterCounterparty.safeParse(counterparty('tag', 'vip')).success).toBe(true);
  });

  // Second layer. The charter here is correctly signed, so `compileCharter`
  // gets past its signature check and reaches the bucket write — which is the
  // only way to prove the guard there is doing anything.
  it('the compiler refuses the key even on a correctly signed charter', () => {
    expect(() => compileCharter(signedCharterWithTag('__proto__'))).toThrow(/__proto__/);
  });

  it('leaves the global prototype clean when it refuses', () => {
    try {
      compileCharter(signedCharterWithTag('__proto__'));
    } catch {
      // The refusal is the previous test's subject; here only the absence of a
      // write on the way to it matters.
    }
    expect(({} as Record<string, unknown>)['email.reply']).toBeUndefined();
  });

  it('still compiles an ordinary counterparty tag', () => {
    const bundle = compileCharter(signedCharterWithTag('vip'));
    expect(bundle.counterpartyAutonomy.byTag['vip']).toEqual({ 'email.reply': 'draft_only' });
  });
});
