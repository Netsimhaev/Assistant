/**
 * The WhatsApp line the owner gets about a mail from a real person (spec
 * §2.6): who sent it, then what kind of mail it is and the triage summary.
 *
 * Every field is sender-written or model output over sender-written text, so
 * every one goes through `stripBidiControls` — a direction override in a
 * display name or summary changes what the owner reads without changing the
 * bytes (CLAUDE.md, "every string the owner reads that can carry a stranger's
 * bytes"). The name and summary are also folded onto one line each, so a
 * display name carrying a newline cannot forge a second line of the notice.
 */
import { stripBidiControls } from '../util/bidi.js';
import type { MailCategory } from './mailbox.js';

/** Only the two categories that ever notify have a word. */
const CATEGORY_WORDS: Partial<Record<MailCategory, string>> = {
  invoice: 'חשבונית',
  question: 'שאלה שמחכה לתשובה',
};

function oneLine(value: string): string {
  return stripBidiControls(value).replace(/\s+/g, ' ').trim();
}

export interface MailNoticeInput {
  fromName: string | null;
  fromAddress: string;
  summary: string;
}

export function renderMailNotice(mail: MailNoticeInput, categories: readonly MailCategory[]): string {
  const address = oneLine(mail.fromAddress);
  const name = mail.fromName === null ? '' : oneLine(mail.fromName);
  const who = name === '' ? address : `${name} <${address}>`;
  const words = categories
    .map((c) => CATEGORY_WORDS[c])
    .filter((w): w is string => w !== undefined)
    .join(' · ');
  return `📧 ${who}\n${words}: ${oneLine(mail.summary)}`;
}
