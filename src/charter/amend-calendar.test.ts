import { describe, expect, it } from 'vitest';
import { BusinessCharter } from '../domain/charter.js';
import type { CharterConnection } from '../domain/connection.js';
import { buildCharter } from '../test/fixtures.js';
import {
  CALENDAR_SUBPROCESSOR,
  buildCalendarAmendment,
  buildCalendarRevert,
  calendarConnection,
  describeCalendarAmendment,
  signedCalendarProvider,
} from './amend-calendar.js';
import { buildMailboxAmendment } from './amend-mailbox.js';
import { signCharter, verifyCharterSignature } from './sign.js';

const NOW = new Date('2026-11-07T08:00:00.000Z');

const OFFICE_CALENDAR: CharterConnection = {
  system: 'office-calendar',
  label: 'יומן המשרד',
  channel: 'api',
  serves: ['calendar.read'],
  target: null,
  subprocessor: null,
};

const OFFICE_MAIL: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

/** Serves a calendar tool AND something else: it must survive, minus the calendar tools. */
const SHARED: CharterConnection = {
  system: 'workspace',
  label: 'סביבת עבודה',
  channel: 'api',
  serves: ['calendar.read', 'calendar.write', 'crm.write'],
  target: 'workspace-calendars',
  subprocessor: null,
};

function sign(amendment: ReturnType<typeof buildCalendarAmendment>): BusinessCharter {
  return BusinessCharter.parse(
    signCharter(amendment, { signedByPersonId: 'owner', method: 'dashboard_click', signedAt: NOW }),
  );
}

describe('buildCalendarAmendment', () => {
  it('drops office-calendar and adds one calendar connection serving read and write', () => {
    const active = buildCharter({ connections: [OFFICE_MAIL, OFFICE_CALENDAR] });
    const signed = sign(buildCalendarAmendment(active, NOW, 'google'));
    expect(verifyCharterSignature(signed)).toEqual({ valid: true });
    expect(signed.connections.map((c) => c.system)).toEqual(['office-mail', 'calendar']);
    expect(signed.connections.find((c) => c.system === 'calendar')).toEqual({
      system: 'calendar',
      label: 'יומן העסק',
      channel: 'api',
      serves: ['calendar.read', 'calendar.write'],
      target: null,
      subprocessor: CALENDAR_SUBPROCESSOR.google,
    });
    expect(calendarConnection('microsoft').subprocessor).toBe(CALENDAR_SUBPROCESSOR.microsoft);
  });

  it('narrows a shared connection instead of dropping it, and describes the diff', () => {
    const active = buildCharter({ connections: [OFFICE_CALENDAR, SHARED] });
    const amended = buildCalendarAmendment(active, NOW, 'microsoft');
    expect(amended.connections.find((c) => c.system === 'workspace')?.serves).toEqual(['crm.write']);
    const servingCalendar = amended.connections.filter((c) => c.serves.some((t) => t.startsWith('calendar.')));
    expect(servingCalendar.map((c) => c.system)).toEqual(['calendar']);
    const diff = describeCalendarAmendment(active, 'microsoft');
    expect(diff.dropped).toEqual(['office-calendar']);
    expect(diff.narrowed).toEqual(['workspace']);
    expect(diff.subprocessorAdded).toBe(!active.data.subprocessorsAllowed.includes(CALENDAR_SUBPROCESSOR.microsoft));
  });

  it('copies every other charter field unchanged', () => {
    const active = buildCharter({ connections: [OFFICE_MAIL, OFFICE_CALENDAR] });
    const amended = buildCalendarAmendment(active, NOW, 'microsoft');
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
    // Absent subprocessor: appended after the existing ones, nothing else changes.
    expect(active.data.subprocessorsAllowed).not.toContain(CALENDAR_SUBPROCESSOR.microsoft);
    expect(amended.data.subprocessorsAllowed).toEqual([
      ...active.data.subprocessorsAllowed,
      CALENDAR_SUBPROCESSOR.microsoft,
    ]);
    // Already allowed: unchanged.
    expect(active.data.subprocessorsAllowed).toContain(CALENDAR_SUBPROCESSOR.google);
    expect(buildCalendarAmendment(active, NOW, 'google').data.subprocessorsAllowed).toEqual(
      active.data.subprocessorsAllowed,
    );
  });

  it('carries a new distinct version superseding the active one', () => {
    const active = buildCharter({ connections: [OFFICE_CALENDAR] });
    const a = buildCalendarAmendment(active, NOW, 'google');
    const b = buildCalendarAmendment(active, NOW, 'google');
    expect(a.charterVersion.startsWith(`${active.charterVersion}.cal-`)).toBe(true);
    expect(a.charterVersion).not.toBe(b.charterVersion);
    expect(a.supersedes).toBe(active.charterVersion);
    expect(a.effectiveFrom).toBe(NOW.toISOString());
  });

  it('refuses a second calendar connection', () => {
    const active = sign(buildCalendarAmendment(buildCharter({ connections: [OFFICE_CALENDAR] }), NOW, 'google'));
    expect(() => buildCalendarAmendment(active, NOW, 'microsoft')).toThrow(/calendar/);
    expect(() => describeCalendarAmendment(active, 'microsoft')).toThrow(/calendar/);
  });

  it('does not mutate the active charter', () => {
    const active = buildCharter({ connections: [OFFICE_CALENDAR, SHARED] });
    const before = JSON.stringify(active);
    buildCalendarAmendment(active, NOW, 'google');
    expect(JSON.stringify(active)).toBe(before);
  });
});

describe('signedCalendarProvider', () => {
  it('reads the provider from the subprocessor, positively', () => {
    expect(signedCalendarProvider(calendarConnection('google'))).toBe('google');
    expect(signedCalendarProvider(calendarConnection('microsoft'))).toBe('microsoft');
    expect(signedCalendarProvider({ ...calendarConnection('google'), subprocessor: 'someone-else' })).toBeNull();
    expect(signedCalendarProvider({ ...calendarConnection('google'), subprocessor: null })).toBeNull();
  });
});

describe('buildCalendarRevert', () => {
  it('revert restores the replaced connections and removes the calendar', () => {
    const before = buildCharter({ connections: [OFFICE_MAIL, OFFICE_CALENDAR, SHARED] });
    const active = sign(buildCalendarAmendment(before, NOW, 'microsoft'));
    const revert = sign(buildCalendarRevert(active, NOW, before));
    expect(revert.connections.some((c) => c.system === 'calendar')).toBe(false);
    expect(revert.connections.map((c) => c.system).sort()).toEqual(
      ['office-calendar', 'office-mail', 'workspace'].sort(),
    );
    expect(revert.connections.find((c) => c.system === 'workspace')).toEqual(SHARED);
    expect(revert.supersedes).toBe(active.charterVersion);
    expect(revert.charterVersion).not.toBe(active.charterVersion);
    expect(verifyCharterSignature(revert)).toEqual({ valid: true });
  });

  it('keeps connections added after the amendment', () => {
    const before = buildCharter({ connections: [OFFICE_CALENDAR] });
    const amended = buildCalendarAmendment(before, NOW, 'google');
    const later: CharterConnection = { ...OFFICE_MAIL, system: 'later-system', serves: ['mail.send'] };
    const active = sign({ ...amended, connections: [...amended.connections, later] });
    const revert = buildCalendarRevert(active, NOW, before);
    expect(revert.connections.map((c) => c.system).sort()).toEqual(['later-system', 'office-calendar']);
  });

  it('refuses a previous charter that itself declares a calendar', () => {
    const active = sign(buildCalendarAmendment(buildCharter({ connections: [OFFICE_CALENDAR] }), NOW, 'google'));
    expect(() => buildCalendarRevert(active, NOW, active)).toThrow(/calendar/);
  });

  it('never resurrects non-calendar tools, and restores a dropped connection with its calendar tools only', () => {
    const WORKSPACE: CharterConnection = {
      system: 'workspace',
      label: 'סביבת עבודה',
      channel: 'api',
      serves: ['mail.send', 'calendar.read'],
      target: null,
      subprocessor: null,
    };
    const before = buildCharter({ connections: [WORKSPACE] });
    // Mailbox amendment took mail.send; the calendar amendment then dropped
    // the remaining (calendar-only) workspace connection.
    const withMailbox = sign(buildMailboxAmendment(before, NOW, 'google'));
    const active = sign(buildCalendarAmendment(withMailbox, NOW, 'google'));
    expect(active.connections.map((c) => c.system)).toEqual(['mailbox', 'calendar']);
    // A stale `previous` (the charter before BOTH amendments) must not bring mail.send back.
    const revert = sign(buildCalendarRevert(active, NOW, before));
    expect(revert.connections.find((c) => c.system === 'workspace')?.serves).toEqual(['calendar.read']);
    expect(revert.connections.filter((c) => c.serves.includes('mail.send')).map((c) => c.system)).toEqual(['mailbox']);
  });

  it('keeps the active version of a still-active connection and re-adds only its calendar tools', () => {
    const before = buildCharter({ connections: [SHARED] });
    const amended = buildCalendarAmendment(before, NOW, 'google');
    // The owner later signed an extra tool onto the narrowed connection.
    const active = sign({
      ...amended,
      connections: amended.connections.map((c) =>
        c.system === 'workspace' ? { ...c, serves: ['crm.write', 'crm.read'] } : c,
      ),
    });
    const revert = buildCalendarRevert(active, NOW, before);
    const workspace = revert.connections.find((c) => c.system === 'workspace');
    expect([...(workspace?.serves ?? [])].sort()).toEqual(
      ['calendar.read', 'calendar.write', 'crm.read', 'crm.write'].sort(),
    );
  });

  it('refuses when the active charter has no calendar connection', () => {
    const before = buildCharter({ connections: [OFFICE_CALENDAR] });
    expect(() => buildCalendarRevert(before, NOW, before)).toThrow(/calendar/);
  });
});
