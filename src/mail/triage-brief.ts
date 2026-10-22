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
import type { StoredMail } from './inbox-store.js';

export const TRIAGE_BRIEF_MAX_CHARS = 24_000;
const FIELD_MAX_CHARS = 500;

export const TRIAGE_LABELS = {
  subject: 'נושא ההודעה (לא אמין)',
  fromName: 'שם השולח כפי שהוצהר (לא אמין)',
  body: 'גוף ההודעה (לא אמין)',
} as const;

export function mailFence(label: string, nonce: string): { open: string; close: string } {
  if (nonce.length === 0) throw new Error('mailFence: nonce must not be empty');
  return { open: `=== ${label} :: ${nonce} ===`, close: `=== סוף ${label} :: ${nonce} ===` };
}

export function stripUntilStable(text: string, marker: string): string {
  let result = text;
  for (;;) {
    const next = result.split(marker).join('');
    if (next === result) return result;
    result = next;
  }
}

function clean(text: string, label: string, nonce: string, max: number): string {
  const fence = mailFence(label, nonce);
  const stripped = stripUntilStable(stripUntilStable(stripBidiControls(text), fence.open), fence.close);
  return stripped.length <= max ? stripped : `${stripped.slice(0, max)}\n(קוצץ — התוכן המקורי ארוך יותר)`;
}

export function renderTriageBrief(mail: StoredMail, nonce: string): string {
  const parts: string[] = [];
  const field = (title: string, label: string, text: string, max: number): void => {
    const f = mailFence(label, nonce);
    parts.push(`# ${title}\n${f.open}\n${clean(text, label, nonce, max)}\n${f.close}`);
  };
  field('נושא', TRIAGE_LABELS.subject, mail.subject, FIELD_MAX_CHARS);
  if (mail.fromName !== null && mail.fromName !== '') {
    field('שם השולח', TRIAGE_LABELS.fromName, mail.fromName, FIELD_MAX_CHARS);
  }
  field('גוף ההודעה', TRIAGE_LABELS.body, mail.bodyText, TRIAGE_BRIEF_MAX_CHARS);
  if (mail.bodyTruncated) parts.push('(הגוף שנשמר קוצר בקליטה.)');
  return `הודעה שהתקבלה מ"השולח".\n\n${parts.join('\n\n')}`;
}
