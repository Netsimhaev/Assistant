import { describe, expect, it } from 'vitest';
import { BusinessCharter } from './charter.js';
import type { CharterConnection } from './connection.js';
import { buildCharter } from '../test/fixtures.js';
import { crmConnection, crmFixture } from '../test/external-fixtures.js';

/** A charter with the given systems and connections. Signature is not re-checked by parse. */
function charterWith(externalSystems: unknown[], connections: CharterConnection[], currency = 'ILS'): unknown {
  const base = buildCharter({ currency });
  return { ...base, externalSystems, connections };
}

function issues(input: unknown): string[] {
  const result = BusinessCharter.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

describe('charter — external system pairing', () => {
  it('accepts a system with exactly its one connection', () => {
    expect(issues(charterWith([crmFixture()], [crmConnection()]))).toEqual([]);
  });

  it('refuses a system with no connection', () => {
    expect(issues(charterWith([crmFixture()], [])).length).toBeGreaterThan(0);
  });

  it('refuses a connection that serves anything but exactly ext.call and ext.read', () => {
    expect(issues(charterWith([crmFixture()], [{ ...crmConnection(), serves: ['ext.read'] }])).length).toBeGreaterThan(0);
    expect(
      issues(charterWith([crmFixture()], [{ ...crmConnection(), serves: ['ext.call', 'ext.read', 'crm.write'] }])).length,
    ).toBeGreaterThan(0);
  });

  it('accepts the two tools in either order', () => {
    expect(issues(charterWith([crmFixture()], [{ ...crmConnection(), serves: ['ext.read', 'ext.call'] }]))).toEqual([]);
  });

  it('refuses a connection whose target is not the system id', () => {
    expect(issues(charterWith([crmFixture()], [{ ...crmConnection(), target: 'other' }])).length).toBeGreaterThan(0);
    expect(issues(charterWith([crmFixture()], [{ ...crmConnection(), target: null }])).length).toBeGreaterThan(0);
  });

  it('refuses a browser channel', () => {
    expect(issues(charterWith([crmFixture()], [{ ...crmConnection(), channel: 'browser' }])).length).toBeGreaterThan(0);
  });

  it('refuses an ext: connection with no definition', () => {
    expect(issues(charterWith([], [crmConnection()])).length).toBeGreaterThan(0);
  });

  it('refuses two systems with one id', () => {
    expect(issues(charterWith([crmFixture(), crmFixture()], [crmConnection()])).length).toBeGreaterThan(0);
  });

  it('defaults externalSystems to an empty list', () => {
    const { externalSystems: _omit, ...rest } = buildCharter() as unknown as Record<string, unknown>;
    const parsed = BusinessCharter.parse(rest);
    expect(parsed.externalSystems).toEqual([]);
  });
});

describe('charter — external money currency', () => {
  it('refuses a money operation whose currency is not the charter currency, in Hebrew', () => {
    const found = issues(charterWith([crmFixture()], [crmConnection()], 'USD'));
    expect(found.some((m) => /[֐-׿]/.test(m) && m.includes('ILS'))).toBe(true);
  });
});
