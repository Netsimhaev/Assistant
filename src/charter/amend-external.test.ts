import { describe, expect, it } from 'vitest';
import { BusinessCharter } from '../domain/charter.js';
import type { CharterConnection } from '../domain/connection.js';
import { ExternalSystem } from '../domain/external-system.js';
import { crmConnection, crmFixture } from '../test/external-fixtures.js';
import { buildCharter } from '../test/fixtures.js';
import {
  NoExternalSystemToRemoveError,
  buildExternalAmendment,
  buildExternalRemoval,
  describeExternalAmendment,
  externalConnection,
  externalSubprocessor,
} from './amend-external.js';
import { signCharter, verifyCharterSignature } from './sign.js';

const NOW = new Date('2026-11-19T08:00:00.000Z');

const OFFICE_MAIL: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

const CRM = ExternalSystem.parse(crmFixture());

function sign(amendment: ReturnType<typeof buildExternalAmendment>): BusinessCharter {
  return BusinessCharter.parse(
    signCharter(amendment, { signedByPersonId: 'owner', method: 'dashboard_click', signedAt: NOW }),
  );
}

function billing(): ExternalSystem {
  const raw = crmFixture();
  return ExternalSystem.parse({ ...raw, id: 'billing', label: 'מערכת החיובים', webhook: null, scan: null });
}

describe('buildExternalAmendment', () => {
  it('adds the system and its paired ext: connection, naming the subprocessor', () => {
    const active = buildCharter({ connections: [OFFICE_MAIL] });
    const signed = sign(buildExternalAmendment(active, CRM, NOW));
    expect(verifyCharterSignature(signed)).toEqual({ valid: true });
    expect(signed.externalSystems.map((s) => s.id)).toEqual(['crm']);
    expect(signed.connections.map((c) => c.system)).toEqual(['office-mail', 'ext:crm']);
    expect(signed.connections.find((c) => c.system === 'ext:crm')).toEqual({
      system: 'ext:crm',
      label: CRM.label,
      channel: 'api',
      serves: ['ext.call', 'ext.read'],
      target: 'crm',
      subprocessor: 'ext:crm',
    });
    expect(externalSubprocessor('crm')).toBe('ext:crm');
    expect(signed.data.subprocessorsAllowed).toContain('ext:crm');
    expect(signed.supersedes).toBe(active.charterVersion);
    expect(signed.charterVersion).not.toBe(active.charterVersion);
    expect(signed.effectiveFrom).toBe(NOW.toISOString());
  });

  it('copies every non-connection field byte-for-byte', () => {
    const active = buildCharter({ connections: [OFFICE_MAIL] });
    const amended = buildExternalAmendment(active, CRM, NOW);
    const { signature: _s, ...unsignedActive } = active;
    const changed = new Set(['charterVersion', 'effectiveFrom', 'supersedes', 'externalSystems', 'connections', 'data']);
    for (const key of Object.keys(unsignedActive) as (keyof typeof unsignedActive)[]) {
      if (changed.has(key)) continue;
      expect(JSON.stringify(amended[key]), key).toBe(JSON.stringify(unsignedActive[key]));
    }
    // `data`: only the subprocessor list moved.
    const { subprocessorsAllowed: before, ...dataBefore } = active.data;
    const { subprocessorsAllowed: after, ...dataAfter } = amended.data;
    expect(JSON.stringify(dataAfter)).toBe(JSON.stringify(dataBefore));
    expect(after).toEqual([...before, 'ext:crm']);
    // The other connections, untouched.
    expect(amended.connections[0]).toEqual(OFFICE_MAIL);
    // No key appears that the active charter did not have, beyond `supersedes`.
    expect(Object.keys(amended).sort()).toEqual([...new Set([...Object.keys(unsignedActive), 'supersedes'])].sort());
  });

  it('does not add the subprocessor twice', () => {
    const active = buildCharter({});
    const withAllowed = { ...active, data: { ...active.data, subprocessorsAllowed: ['ext:crm'] } };
    expect(buildExternalAmendment(withAllowed, CRM, NOW).data.subprocessorsAllowed).toEqual(['ext:crm']);
  });

  it('replaces a signed system and its connection in place, and reports the diff', () => {
    const first = sign(buildExternalAmendment(buildCharter({ connections: [OFFICE_MAIL] }), CRM, NOW));
    const second = sign(buildExternalAmendment(first, billing(), NOW));
    const raw = crmFixture();
    const ops = raw.operations.filter((o) => o.name !== 'delete_customer').map((o) =>
      o.name === 'update_customer' ? { ...o, label: 'עדכון פרטי לקוח' } : o,
    );
    ops.push({ ...raw.operations[0]!, name: 'search_customers', label: 'חיפוש לקוחות' });
    const changed = ExternalSystem.parse({ ...raw, baseUrl: 'https://api.other-crm.example.net/v2', operations: ops });

    const diff = describeExternalAmendment(second, changed);
    expect(diff).toEqual({
      replaces: true,
      added: ['search_customers'],
      removed: ['delete_customer'],
      changed: ['update_customer'],
      host: { before: 'api.crm.example.com', after: 'api.other-crm.example.net' },
      otherChanged: true,
    });

    const third = sign(buildExternalAmendment(second, changed, NOW));
    expect(third.externalSystems.map((s) => s.id)).toEqual(['crm', 'billing']);
    expect(third.externalSystems[0]!.baseUrl).toBe('https://api.other-crm.example.net/v2');
    expect(third.connections.map((c) => c.system)).toEqual(['office-mail', 'ext:crm', 'ext:billing']);
    expect(third.connections.filter((c) => c.system === 'ext:crm')).toHaveLength(1);
  });

  it('describes a first signature as adding every operation', () => {
    const diff = describeExternalAmendment(buildCharter({}), CRM);
    expect(diff.replaces).toBe(false);
    expect(diff.added).toEqual(CRM.operations.map((o) => o.name));
    expect(diff.host).toBeNull();
  });

  it('replacing a charter whose connection had no subprocessor gives it one', () => {
    const active = BusinessCharter.parse(
      buildCharter({ externalSystems: [crmFixture()], connections: [crmConnection()] }),
    );
    const amended = sign(buildExternalAmendment(active, CRM, NOW));
    expect(amended.connections.find((c) => c.system === 'ext:crm')).toEqual(externalConnection(CRM));
  });
});

describe('buildExternalRemoval', () => {
  it('drops the system and its connection, keeps the subprocessor allowance and everything else', () => {
    const withTwo = sign(
      buildExternalAmendment(sign(buildExternalAmendment(buildCharter({ connections: [OFFICE_MAIL] }), CRM, NOW)), billing(), NOW),
    );
    const removed = sign(buildExternalRemoval(withTwo, 'crm', NOW));
    expect(removed.externalSystems.map((s) => s.id)).toEqual(['billing']);
    expect(removed.connections.map((c) => c.system)).toEqual(['office-mail', 'ext:billing']);
    expect(removed.data.subprocessorsAllowed).toEqual(withTwo.data.subprocessorsAllowed);
    expect(removed.supersedes).toBe(withTwo.charterVersion);
    expect(JSON.stringify(removed.forbidden)).toBe(JSON.stringify(withTwo.forbidden));
  });

  it('refuses to remove a system that is not signed', () => {
    expect(() => buildExternalRemoval(buildCharter({}), 'crm', NOW)).toThrow(NoExternalSystemToRemoveError);
  });
});
