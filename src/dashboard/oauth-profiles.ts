/**
 * Per-system OAuth profiles: which provider, which scopes and which endpoints
 * the consent ceremony uses for a charter-declared connection.
 *
 * Positive matching only. A connection earns a profile by NAME and by what it
 * serves -- `mailbox` serving `mail.send`, or any connection serving
 * `calendar.read` -- never by exclusion. `office-mail` also serves
 * `mail.send` and gets `null`: it is the static-SMTP connection, and an OAuth
 * grant written onto it would poison the mail path (see `oauth-eligibility.ts`).
 */
import type { CharterConnection } from '../domain/connection.js';
import { MAILBOX_SYSTEM } from '../mail/mailbox.js';
import type { MailProvider } from '../mail/mailbox.js';

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
export const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

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
 * `provider` is the owner's choice for the mailbox (the start route validates
 * it against `MailProvider`); it defaults to `'google'` so a caller that only
 * asks "is this connection eligible at all?" need not pick one. Calendar is
 * Google-only: asking for another provider is `null`.
 */
export function oauthProfileFor(
  connection: CharterConnection,
  provider: MailProvider = 'google',
): OAuthProfile | null {
  if (connection.system === MAILBOX_SYSTEM && connection.serves.includes('mail.send')) {
    return MAILBOX_PROFILES[provider];
  }
  if (connection.serves.includes('calendar.read')) {
    return provider === 'google' ? GOOGLE_CALENDAR_PROFILE : null;
  }
  return null;
}
