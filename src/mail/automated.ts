import type { IncomingMail } from './inbox-store.js';

const AUTOMATED_LOCAL_PART = /^(no-?reply|do-?not-?reply|mailer-daemon|notifications?)$/i;

/**
 * Positive rule: a mail is automated if any header flag is set or the sender's
 * local part is one of the known machine names. A person-looking address such
 * as noreply-team@ is not matched (whole local part must equal the name).
 */
export function isAutomatedSender(
  flags: IncomingMail['headerFlags'],
  fromAddress: string,
): boolean {
  if (flags.listUnsubscribe || flags.autoSubmitted || flags.bulkPrecedence) return true;
  const at = fromAddress.lastIndexOf('@');
  const local = at >= 0 ? fromAddress.slice(0, at) : fromAddress;
  return AUTOMATED_LOCAL_PART.test(local.trim());
}
