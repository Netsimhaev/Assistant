/** Shared constants for the mailbox connection. */

/** The connector system name, as it appears in the charter and `oauth_grants`. */
export const MAILBOX_SYSTEM = 'mailbox';

export type MailProvider = 'google' | 'microsoft';

/** The closed label set. Nothing else is ever written to a mailbox as a label. */
export const MAIL_LABELS = { invoice: 'חשבוניות', question: 'ממתין לתשובה' } as const;

export type MailCategory = 'invoice' | 'question' | 'document' | 'other';
