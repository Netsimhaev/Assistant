import { describe, expect, it } from 'vitest';
import type { CharterConnection } from '../domain/connection.js';
import { connectionAcceptsOAuthCeremony } from './oauth-eligibility.js';

/**
 * Unit coverage for the predicate `runtime.ts` (adapter registration),
 * `oauth-routes.ts` (the ceremony gate, item 1a) and `views.ts` (the connect
 * link, item 1b) all now share. `runtime.test.ts` and `oauth-routes.test.ts`
 * already prove the WIRING through real calls; this proves the function
 * itself for the shapes that actually matter, in isolation.
 */
describe('connectionAcceptsOAuthCeremony', () => {
  const CALENDAR: CharterConnection = {
    system: 'office-calendar',
    label: 'יומן המשרד',
    channel: 'api',
    serves: ['calendar.read'],
    target: null,
    subprocessor: null,
  };

  it('accepts a connection on the api channel that serves calendar.read', () => {
    expect(connectionAcceptsOAuthCeremony(CALENDAR)).toBe(true);
  });

  it('refuses when there is no connection at all', () => {
    expect(connectionAcceptsOAuthCeremony(undefined)).toBe(false);
  });

  it('refuses a connection that serves calendar.read on the browser channel, not api', () => {
    expect(connectionAcceptsOAuthCeremony({ ...CALENDAR, channel: 'browser' })).toBe(false);
  });

  it('refuses a connection that does not serve any Google-calendar tool — the office-mail case', () => {
    expect(
      connectionAcceptsOAuthCeremony({
        system: 'office-mail',
        label: 'תיבת המשרד',
        channel: 'api',
        serves: ['mail.send'],
        target: null,
        subprocessor: null,
      }),
    ).toBe(false);
  });

  it('accepts a connection that serves calendar.read alongside other tools', () => {
    expect(connectionAcceptsOAuthCeremony({ ...CALENDAR, serves: ['mail.send', 'calendar.read'] })).toBe(
      true,
    );
  });
});
