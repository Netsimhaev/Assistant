/**
 * The brief the quarantined `intake.triage` reader sees. Mail is hostile by
 * definition, so every field written by the sender is fenced between
 * per-call-nonce markers (same rule as `sdk/gov-verify.ts`; the nonce is the
 * boundary, `stripUntilStable` is belt-and-braces).
 *
 * The header addresses (From / Reply-To / To) are NEVER included: the model
 * has no use for them, and a brief that never carries them cannot be talked
 * into echoing one. The sender is described as "השולח". Addresses the sender
 * typed inside the body stay as text — we do not rewrite hostile content.
 */
import { stripBidiControls } from '../util/bidi.js';
import { buildFence, stripFenceMarkers } from '../util/fence.js';
import type { StoredMail } from './inbox-store.js';

export const TRIAGE_BRIEF_MAX_CHARS = 24_000;
const FIELD_MAX_CHARS = 500;

export const TRIAGE_LABELS = {
  subject: 'נושא ההודעה (לא אמין)',
  fromName: 'שם השולח כפי שהוצהר (לא אמין)',
  body: 'גוף ההודעה (לא אמין)',
} as const;

function clean(text: string, label: string, nonce: string, max: number): string {
  const stripped = stripFenceMarkers(stripBidiControls(text), buildFence(label, nonce));
  return stripped.length <= max ? stripped : `${stripped.slice(0, max)}\n(קוצץ — התוכן המקורי ארוך יותר)`;
}

const ADDRESS_LIKE = /\S@\S/;

/** A display name that is (or embeds) an address would put a header address in the brief. */
function displayNameIsSafe(mail: StoredMail): boolean {
  const name = mail.fromName;
  if (name === null || name.trim() === '') return false;
  if (ADDRESS_LIKE.test(name)) return false;
  const lower = name.toLowerCase();
  for (const addr of [mail.fromAddress, mail.replyTo, ...mail.toAddresses]) {
    if (addr !== null && addr !== '' && lower.includes(addr.toLowerCase())) return false;
  }
  return true;
}

export function renderTriageBrief(mail: StoredMail, nonce: string): string {
  const parts: string[] = [];
  const field = (title: string, label: string, text: string, max: number): void => {
    const f = buildFence(label, nonce);
    parts.push(`# ${title}\n${f.open}\n${clean(text, label, nonce, max)}\n${f.close}`);
  };
  field('נושא', TRIAGE_LABELS.subject, mail.subject, FIELD_MAX_CHARS);
  if (mail.fromName !== null && displayNameIsSafe(mail)) {
    field('שם השולח', TRIAGE_LABELS.fromName, mail.fromName, FIELD_MAX_CHARS);
  }
  field('גוף ההודעה', TRIAGE_LABELS.body, mail.bodyText, TRIAGE_BRIEF_MAX_CHARS);
  if (mail.bodyTruncated) parts.push('(הגוף שנשמר קוצר בקליטה.)');
  return `הודעה שהתקבלה מ"השולח".\n\n${parts.join('\n\n')}`;
}
