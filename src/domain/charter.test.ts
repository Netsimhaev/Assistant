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

/** Each issue as `path: message`, so a test can say WHICH rule fired. */
function issues(input: unknown): string[] {
  const result = BusinessCharter.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

const NEEDS_ONE = /^externalSystems\.0: external system "crm" needs exactly one connection named "ext:crm"$/;
const PAIRING_SHAPE = /^externalSystems\.0: connection "ext:crm" must serve exactly ext\.call and ext\.read, target "crm", on the api channel$/;

describe('charter — external system pairing', () => {
  it('accepts a system with exactly its one connection', () => {
    expect(issues(charterWith([crmFixture()], [crmConnection()]))).toEqual([]);
  });

  it('refuses a system with no connection', () => {
    expect(issues(charterWith([crmFixture()], []))).toEqual([expect.stringMatching(NEEDS_ONE)]);
  });

  it('refuses a connection that serves only one of the two tools', () => {
    expect(issues(charterWith([crmFixture()], [{ ...crmConnection(), serves: ['ext.read'] }]))).toEqual([
      expect.stringMatching(PAIRING_SHAPE),
    ]);
  });

  it('refuses a connection that serves a third tool beside the two', () => {
    expect(
      issues(charterWith([crmFixture()], [{ ...crmConnection(), serves: ['ext.call', 'ext.read', 'crm.write'] }])),
    ).toEqual([expect.stringMatching(PAIRING_SHAPE)]);
  });

  it('accepts the two tools in either order', () => {
    expect(issues(charterWith([crmFixture()], [{ ...crmConnection(), serves: ['ext.read', 'ext.call'] }]))).toEqual([]);
  });

  it('refuses a connection whose target is another id', () => {
    expect(issues(charterWith([crmFixture()], [{ ...crmConnection(), target: 'other' }]))).toEqual([
      expect.stringMatching(PAIRING_SHAPE),
    ]);
  });

  it('refuses a catch-all (null) target', () => {
    expect(issues(charterWith([crmFixture()], [{ ...crmConnection(), target: null }]))).toEqual([
      expect.stringMatching(PAIRING_SHAPE),
    ]);
  });

  it('refuses a browser channel', () => {
    expect(issues(charterWith([crmFixture()], [{ ...crmConnection(), channel: 'browser' }]))).toEqual([
      expect.stringMatching(PAIRING_SHAPE),
    ]);
  });

  it('refuses an ext: connection with no definition', () => {
    expect(issues(charterWith([], [crmConnection()]))).toEqual([
      'connections.0.system: connection "ext:crm" has no external system definition',
    ]);
  });

  it('refuses an ordinary connection that serves an ext.* tool', () => {
    const office: CharterConnection = {
      system: 'office-crm',
      label: 'CRM',
      channel: 'api',
      serves: ['crm.write', 'ext.read'],
      target: 'other',
      subprocessor: null,
    };
    expect(issues(charterWith([crmFixture()], [crmConnection(), office]))).toEqual([
      'connections.1.serves: tool "ext.read" may be served only by an "ext:" connection',
    ]);
  });

  it('refuses two systems with one id', () => {
    expect(issues(charterWith([crmFixture(), crmFixture()], [crmConnection()]))).toContain(
      'externalSystems.1.id: duplicate external system "crm"',
    );
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
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^externalSystems\.0\.operations\.4\.amount\.currency: /);
    expect(found[0]).toMatch(/[֐-׿]/);
    expect(found[0]).toContain('ILS');
    expect(found[0]).toContain('USD');
  });
});
