import type { MailProvider } from '../mailbox.js';
import { createGmailClient } from './gmail.js';
import { createGraphClient } from './graph.js';
import type { MailboxClient } from './types.js';

/** The real client for a mailbox provider (shared by the poller and the sent-mail source). */
export function clientFor(provider: MailProvider): MailboxClient {
  return provider === 'google' ? createGmailClient() : createGraphClient();
}
