/**
 * Per-system OAuth profiles: which provider, which scopes and which endpoints
 * the consent ceremony uses for a charter-declared connection.
 *
 * Positive matching only. A connection earns a profile by NAME and by what it
 * serves -- `mailbox` serving `mail.send`, the `calendar` system serving
 * `calendar.write` (read-write, Google or Microsoft), or any other connection
 * serving `calendar.read` (the legacy read-only Google profile) -- never by
 * exclusion. `office-mail` also serves
 * `mail.send` and gets `null`: it is the static-SMTP connection, and an OAuth
 * grant written onto it would poison the mail path (see `oauth-eligibility.ts`).
 */
import type { CharterConnection } from '../domain/connection.js';
import { CALENDAR_SYSTEM } from '../calendar/calendar.js';
import { MAILBOX_SYSTEM } from '../mail/mailbox.js';
import type { MailProvider } from '../mail/mailbox.js';
import { MICROSOFT_TOKEN_ENDPOINT } from '../orchestrator/adapters/microsoft-token-http.js';

export interface OAuthProfile {
  provider: MailProvider;
  scopes: readonly string[];
  authorizeUrl: string;
  tokenUrl: string;
  /** `null` when the provider has no token revocation endpoint (Microsoft). */
  revokeUrl: string | null;
}

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const MICROSOFT_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const MICROSOFT_TOKEN_URL = MICROSOFT_TOKEN_ENDPOINT;

/** The narrowest scope that allows the one calendar read. Widening it requires re-consent. */
const GOOGLE_CALENDAR_PROFILE: OAuthProfile = {
  provider: 'google',
  scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  authorizeUrl: GOOGLE_AUTHORIZE_URL,
  tokenUrl: GOOGLE_TOKEN_URL,
  revokeUrl: GOOGLE_REVOKE_URL,
};

const MAILBOX_PROFILES: Record<MailProvider, OAuthProfile> = {
  google: {
    provider: 'google',
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'openid',
      'email',
    ],
    authorizeUrl: GOOGLE_AUTHORIZE_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    revokeUrl: GOOGLE_REVOKE_URL,
  },
  microsoft: {
    provider: 'microsoft',
    scopes: ['offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'],
    authorizeUrl: MICROSOFT_AUTHORIZE_URL,
    tokenUrl: MICROSOFT_TOKEN_URL,
    revokeUrl: null,
  },
};

/**
 * The business calendar (`CALENDAR_SYSTEM`), read AND write. Google: events
 * only (no calendar management) plus the read-only calendar list, which is how
 * the calendars to read are discovered. Microsoft: `Calendars.ReadWrite`.
 */
const CALENDAR_PROFILES: Record<MailProvider, OAuthProfile> = {
  google: {
    provider: 'google',
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    ],
    authorizeUrl: GOOGLE_AUTHORIZE_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    revokeUrl: GOOGLE_REVOKE_URL,
  },
  microsoft: {
    provider: 'microsoft',
    scopes: ['offline_access', 'User.Read', 'Calendars.ReadWrite'],
    authorizeUrl: MICROSOFT_AUTHORIZE_URL,
    tokenUrl: MICROSOFT_TOKEN_URL,
    revokeUrl: null,
  },
};

/**
 * `provider` is the owner's choice for the mailbox / the business calendar
 * (the start route validates it against `MailProvider` and the signed charter);
 * it defaults to `'google'` so a caller that only asks "is this connection
 * eligible at all?" need not pick one. Mailbox and business calendar have a
 * profile per provider. The legacy read-only calendar (any other connection
 * serving `calendar.read`) is Google-only: another provider is `null`.
 */
export function oauthProfileFor(
  connection: CharterConnection,
  provider: MailProvider = 'google',
): OAuthProfile | null {
  if (connection.system === MAILBOX_SYSTEM && connection.serves.includes('mail.send')) {
    return MAILBOX_PROFILES[provider];
  }
  // Checked BEFORE the legacy read-only branch: the calendar connection also
  // serves `calendar.read`, and must get the read-write profile.
  if (connection.system === CALENDAR_SYSTEM && connection.serves.includes('calendar.write')) {
    return CALENDAR_PROFILES[provider];
  }
  if (connection.serves.includes('calendar.read')) {
    return provider === 'google' ? GOOGLE_CALENDAR_PROFILE : null;
  }
  return null;
}
