import { describe, expect, it } from 'vitest';
import { BusinessCharter } from '../domain/charter.js';
import { canonicalHash } from '../util/canonical.js';
import { buildCharter } from '../test/fixtures.js';
import {
  WHATSAPP_CONTACTS_SYSTEM,
  WhatsAppContactsAlreadyDeclaredError,
  NoWhatsAppContactsToRevertError,
  buildWhatsAppContactsAmendment,
  buildWhatsAppContactsRevert,
} from './amend-whatsapp-contacts.js';
import { signCharter } from './sign.js';

const NOW = new Date('2026-11-21T08:00:00.000Z');

function sign(u: ReturnType<typeof buildWhatsAppContactsAmendment>): BusinessCharter {
  return BusinessCharter.parse(signCharter(u, { signedByPersonId: 'owner', method: 'dashboard_click', signedAt: NOW }));
}

function rest(c: object): object {
  const { charterVersion: _v, effectiveFrom: _e, supersedes: _s, connections: _c, data, signature: _g, ...others } = c as Record<string, unknown>;
  const { subprocessorsAllowed: _p, ...dataRest } = data as Record<string, unknown>;
  return { ...others, data: dataRest };
}

describe('buildWhatsAppContactsAmendment', () => {
  it('adds the connection and the subprocessor and copies everything else byte-for-byte', () => {
    const active = buildCharter();
    const next = buildWhatsAppContactsAmendment(active, NOW);
    const conn = next.connections.find((c) => c.system === WHATSAPP_CONTACTS_SYSTEM);
    expect(conn).toMatchObject({ channel: 'api', serves: ['wa.send_message'], subprocessor: 'green-api' });
    expect(next.data.subprocessorsAllowed).toContain('green-api');
    expect(next.supersedes).toBe(active.charterVersion);
    expect(canonicalHash(rest(next))).toBe(canonicalHash(rest(active)));
    expect(next.connections.filter((c) => c.system !== WHATSAPP_CONTACTS_SYSTEM)).toEqual(active.connections);
    expect(() => sign(next)).not.toThrow();
  });

  it('refuses a second declaration', () => {
    const signed = sign(buildWhatsAppContactsAmendment(buildCharter(), NOW));
    expect(() => buildWhatsAppContactsAmendment(signed, NOW)).toThrow(WhatsAppContactsAlreadyDeclaredError);
  });
});

describe('buildWhatsAppContactsRevert', () => {
  it('removes the connection and keeps the rest', () => {
    const base = buildCharter();
    const signed = sign(buildWhatsAppContactsAmendment(base, NOW));
    const back = buildWhatsAppContactsRevert(signed, NOW);
    expect(back.connections).toEqual(base.connections);
    expect(back.supersedes).toBe(signed.charterVersion);
  });
  it('throws when nothing to revert', () => {
    expect(() => buildWhatsAppContactsRevert(buildCharter(), NOW)).toThrow(NoWhatsAppContactsToRevertError);
  });
});
