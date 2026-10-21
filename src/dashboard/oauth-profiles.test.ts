import { describe, expect, it } from 'vitest';
import type { CharterConnection } from '../domain/connection.js';
import { oauthProfileFor } from './oauth-profiles.js';

const MAILBOX: CharterConnection = {
  system: 'mailbox',
  label: 'תיבת הדואר',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};
const CALENDAR: CharterConnection = {
  system: 'office-calendar',
  label: 'יומן',
  channel: 'api',
  serves: ['calendar.read'],
  target: null,
  subprocessor: null,
};
const OFFICE_MAIL: CharterConnection = { ...MAILBOX, system: 'office-mail', serves: ['mail.send'] };

describe('oauthProfileFor', () => {
  it('mailbox with microsoft has Mail.ReadWrite and offline_access', () => {
    const profile = oauthProfileFor(MAILBOX, 'microsoft');
    expect(profile).not.toBeNull();
    expect(profile?.provider).toBe('microsoft');
    expect([...(profile?.scopes ?? [])].sort()).toEqual(
      ['Mail.ReadWrite', 'Mail.Send', 'User.Read', 'offline_access'].sort(),
    );
    expect(profile?.authorizeUrl).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(profile?.tokenUrl).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(profile?.revokeUrl).toBeNull();
  });

  it('mailbox with google has gmail.modify and gmail.send', () => {
    const profile = oauthProfileFor(MAILBOX, 'google');
    expect(profile?.provider).toBe('google');
    expect([...(profile?.scopes ?? [])].sort()).toEqual(
      [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/gmail.send',
        'openid',
        'email',
      ].sort(),
    );
    expect(profile?.revokeUrl).toBe('https://oauth2.googleapis.com/revoke');
  });

  it('a connection serving calendar.read gets the Google calendar profile', () => {
    const profile = oauthProfileFor(CALENDAR);
    expect(profile?.provider).toBe('google');
    expect(profile?.scopes).toEqual(['https://www.googleapis.com/auth/calendar.readonly']);
  });

  it('office-mail is null, even though it serves mail.send', () => {
    expect(oauthProfileFor(OFFICE_MAIL)).toBeNull();
    expect(oauthProfileFor(OFFICE_MAIL, 'microsoft')).toBeNull();
  });

  it('the calendar profile is Google only', () => {
    expect(oauthProfileFor(CALENDAR, 'microsoft')).toBeNull();
  });

  it('a mailbox that does not serve mail.send is null', () => {
    expect(oauthProfileFor({ ...MAILBOX, serves: [] })).toBeNull();
  });
});
