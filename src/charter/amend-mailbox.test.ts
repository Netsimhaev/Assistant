import { describe, expect, it } from 'vitest';
import { BusinessCharter } from '../domain/charter.js';
import type { CharterConnection } from '../domain/connection.js';
import { buildCharter } from '../test/fixtures.js';
import { MAILBOX_SUBPROCESSOR, buildMailboxAmendment } from './amend-mailbox.js';
import { signCharter, verifyCharterSignature } from './sign.js';

const NOW = new Date('2026-10-21T08:00:00.000Z');

const OFFICE_MAIL: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

const CALENDAR: CharterConnection = {
  system: 'office-calendar',
  label: 'יומן המשרד',
  channel: 'api',
  serves: ['calendar.read'],
  target: null,
  subprocessor: null,
};

/** A connection that serves mail.send AND something else: it must survive, minus mail.send. */
const SHARED: CharterConnection = {
  system: 'crm-and-mail',
  label: 'CRM',
  channel: 'api',
  serves: ['crm.write', 'mail.send'],
  target: 'supplier-a',
  subprocessor: null,
};

function sign(amendment: ReturnType<typeof buildMailboxAmendment>): BusinessCharter {
  return BusinessCharter.parse(
    signCharter(amendment, { signedByPersonId: 'owner', method: 'dashboard_click', signedAt: NOW }),
  );
}

describe('buildMailboxAmendment', () => {
  it('amendment parses as BusinessCharter, and its signature verifies', () => {
    const active = buildCharter({ connections: [OFFICE_MAIL, CALENDAR] });
    const signed = sign(buildMailboxAmendment(active, NOW, 'google'));
    expect(verifyCharterSignature(signed)).toEqual({ valid: true });
    const mailbox = signed.connections.find((c) => c.system === 'mailbox');
    expect(mailbox).toEqual({
      system: 'mailbox',
      label: 'תיבת המייל של העסק',
      channel: 'api',
      serves: ['mail.send'],
      target: null,
      subprocessor: MAILBOX_SUBPROCESSOR.google,
    });
  });

  it('names the provider the owner chose as the subprocessor, and allows it', () => {
    const active = buildCharter({ connections: [OFFICE_MAIL] });
    const signed = sign(buildMailboxAmendment(active, NOW, 'microsoft'));
    const mailbox = signed.connections.find((c) => c.system === 'mailbox');
    expect(mailbox?.subprocessor).toBe(MAILBOX_SUBPROCESSOR.microsoft);
    expect(signed.data.subprocessorsAllowed).toContain(MAILBOX_SUBPROCESSOR.microsoft);
    // Already-allowed subprocessors stay, in their order.
    expect(signed.data.subprocessorsAllowed.slice(0, active.data.subprocessorsAllowed.length)).toEqual(
      active.data.subprocessorsAllowed,
    );
  });

  it('does not list an already-allowed subprocessor twice', () => {
    const active = buildCharter({ connections: [OFFICE_MAIL] });
    // The fixture already allows google-workspace.
    expect(active.data.subprocessorsAllowed).toContain(MAILBOX_SUBPROCESSOR.google);
    const amended = buildMailboxAmendment(active, NOW, 'google');
    expect(amended.data.subprocessorsAllowed).toEqual(active.data.subprocessorsAllowed);
  });

  it('amendment removes mail.send from office-mail and drops it when empty', () => {
    const active = buildCharter({ connections: [OFFICE_MAIL, CALENDAR, SHARED] });
    const amended = buildMailboxAmendment(active, NOW, 'google');
    expect(amended.connections.map((c) => c.system)).toEqual(['office-calendar', 'crm-and-mail', 'mailbox']);
    expect(amended.connections.find((c) => c.system === 'crm-and-mail')?.serves).toEqual(['crm.write']);
    const servingSend = amended.connections.filter((c) => c.serves.includes('mail.send'));
    expect(servingSend.map((c) => c.system)).toEqual(['mailbox']);
  });

  it('amendment refuses a second mailbox', () => {
    const active = sign(buildMailboxAmendment(buildCharter({ connections: [OFFICE_MAIL] }), NOW, 'google'));
    expect(() => buildMailboxAmendment(active, NOW, 'microsoft')).toThrow(/mailbox/);
  });

  it('amendment keeps every other field byte-identical', () => {
    const active = buildCharter({ connections: [OFFICE_MAIL, CALENDAR] });
    const amended = buildMailboxAmendment(active, NOW, 'microsoft');

    // The fields an amendment is DEFINED to change: its own identity
    // (version, effective date, what it supersedes), the connections, and
    // the one subprocessor the new connection names. Everything else must be
    // exactly what the owner signed before.
    const strip = (c: Record<string, unknown>): Record<string, unknown> => {
      const copy = structuredClone(c);
      delete copy['connections'];
      delete copy['charterVersion'];
      delete copy['signature'];
      delete copy['effectiveFrom'];
      delete copy['supersedes'];
      (copy['data'] as Record<string, unknown>)['subprocessorsAllowed'] = null;
      return copy;
    };
    expect(JSON.stringify(strip(amended))).toBe(JSON.stringify(strip(active)));
  });

  it('carries a new, distinct version that supersedes the active one, effective now', () => {
    const active = buildCharter({ connections: [OFFICE_MAIL] });
    const a = buildMailboxAmendment(active, NOW, 'google');
    const b = buildMailboxAmendment(active, NOW, 'google');
    expect(a.charterVersion).not.toBe(active.charterVersion);
    expect(a.charterVersion.startsWith(`${active.charterVersion}.mbx-`)).toBe(true);
    expect(a.charterVersion).not.toBe(b.charterVersion);
    expect(a.supersedes).toBe(active.charterVersion);
    expect(a.effectiveFrom).toBe(NOW.toISOString());
    expect('signature' in a).toBe(false);
  });

  it('does not mutate the active charter it was built from', () => {
    const active = buildCharter({ connections: [OFFICE_MAIL, SHARED] });
    const before = JSON.stringify(active);
    buildMailboxAmendment(active, NOW, 'google');
    expect(JSON.stringify(active)).toBe(before);
  });
});
