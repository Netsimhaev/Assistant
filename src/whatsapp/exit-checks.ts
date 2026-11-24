/**
 * The six exit checks a drafted auto-reply must pass before it may go out
 * without the owner's approval (phase 2, package 1; owner ruling P3).
 *
 * Pure. Every check is positive ("allowed when X"); the first failure wins,
 * and a value that cannot be read is never the permissive one.
 */
import { ungroundedNumbers } from '../governance/numeric-grounding.js';
import { stripBidiControls } from '../util/bidi.js';
import type { Classification } from './contact-classification.js';
import { topicApplies, type ContactTopic } from './contact-topics.js';
import type { SourceItem } from './sources/types.js';

export const EXIT_REASONS = {
  sources: 'המקורות לא נבדקו עד הסוף או לא שייכים לשולח — אישור עובר דרכך',
  ungrounded: 'בטיוטה יש מספר או תאריך שאין לו מקור — אישור עובר דרכך',
  otherPerson: 'הטיוטה מזכירה אדם אחר — אישור עובר דרכך',
  attachment: 'הצרופה אינה מסמך שנמצא במקורות — אישור עובר דרכך',
  internal: 'הטיוטה נשענת על מסמכים פנימיים — אישור עובר דרכך',
  topic: 'אין נושא מאושר למענה אוטומטי לשולח הזה — אישור עובר דרכך',
  notQuestion: 'זו בקשה — אישור עובר דרכך',
} as const;

export interface ExitCheckInput {
  draft: string;
  attachDocumentId: string | null;
  classification: Classification;
  topic: ContactTopic | null;
  sender: { kind: 'client' | 'supplier' | null; managed: boolean; colleague: boolean; name: string };
  tier12: SourceItem[];
  tier3Used: boolean;
  sourceFailed: boolean;
  ownershipViolation: boolean;
  otherPeople: { names: string[]; emails: string[]; phoneKeys: string[] };
}

export type ExitCheckResult = { ok: true } | { ok: false; reason: string };

const fail = (reason: string): ExitCheckResult => ({ ok: false, reason });

/** Digits only; a local leading 0 becomes 972. Empty when there are no digits. */
function phoneDigits(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return `972${d.slice(1)}`;
  return d;
}

function draftPhoneKeys(draft: string): Set<string> {
  const keys = new Set<string>();
  for (const m of draft.matchAll(/\+?\d[\d\s().-]{5,}\d/g)) keys.add(phoneDigits(m[0]));
  return keys;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentionsName(draftLower: string, nameLower: string): boolean {
  // Whole word; a Hebrew one-letter particle may stick to the front ("לרונית").
  const re = new RegExp(`(?<![\\p{L}\\p{N}])[ולכבמהש]{0,2}${escapeRe(nameLower)}(?![\\p{L}\\p{N}])`, 'u');
  return re.test(draftLower);
}

// ungroundedNumbers() deliberately skips anything next to '/' or ':' (dates
// and times), so those are grounded here: every date or time in the draft
// must appear, normalised, in a source.
const DATE_OR_TIME = /(?<![\d/.:])\d{1,2}(?:[/.]\d{1,2}(?:[/.]\d{2,4})?|:\d{2})(?![\d/:])/g;

function dateTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DATE_OR_TIME)) {
    out.push(
      m[0]
        .replace(/\./g, '/')
        .split(/([/:])/)
        .map((p) => (/^\d+$/.test(p) ? String(Number(p)) : p))
        .join(''),
    );
  }
  return out;
}

function datesGrounded(draft: string, sources: readonly string[]): boolean {
  const known = new Set<string>();
  for (const src of sources) {
    for (const tok of dateTokens(src)) {
      known.add(tok);
      const parts = tok.split('/');
      if (parts.length === 3) known.add(`${parts[0]}/${parts[1]}`);
    }
  }
  return dateTokens(draft).every((t) => known.has(t));
}

export function exitChecks(i: ExitCheckInput): ExitCheckResult {
  if (i.sourceFailed || i.ownershipViolation) return fail(EXIT_REASONS.sources);

  // 1. Numbers must come from the sources. ungroundedNumbers() grounds
  // everything on an empty source list, so that case is handled here.
  if (i.tier12.length === 0) {
    if (/\d/.test(i.draft)) return fail(EXIT_REASONS.ungrounded);
  } else {
    const texts = i.tier12.map((t) => t.text);
    if (ungroundedNumbers(i.draft, texts).length > 0 || !datesGrounded(i.draft, texts)) {
      return fail(EXIT_REASONS.ungrounded);
    }
  }

  // 2. No other person.
  const draftLower = stripBidiControls(i.draft).toLowerCase();
  const senderName = stripBidiControls(i.sender.name).toLowerCase().trim();
  for (const raw of i.otherPeople.names) {
    const name = stripBidiControls(raw).toLowerCase().trim();
    if (name.length < 2 || name === senderName) continue;
    if (mentionsName(draftLower, name)) return fail(EXIT_REASONS.otherPerson);
  }
  for (const raw of i.otherPeople.emails) {
    const email = raw.toLowerCase().trim();
    if (email !== '' && draftLower.includes(email)) return fail(EXIT_REASONS.otherPerson);
  }
  const found = draftPhoneKeys(i.draft);
  for (const raw of i.otherPeople.phoneKeys) {
    const key = phoneDigits(raw);
    if (key !== '' && found.has(key)) return fail(EXIT_REASONS.otherPerson);
  }

  // 3. An attachment must be one of the documents the sources returned.
  if (i.attachDocumentId !== null) {
    const ok = i.tier12.some((t) => t.documentId !== null && t.documentId === i.attachDocumentId);
    if (!ok) return fail(EXIT_REASONS.attachment);
  }

  // 4. Internal (tier 3) material never goes out alone.
  if (i.tier3Used) return fail(EXIT_REASONS.internal);

  // 5. An approved, live auto-reply topic for a managed client or supplier.
  const t = i.topic;
  const topicOk =
    i.sender.managed &&
    !i.sender.colleague &&
    i.sender.kind !== null &&
    t !== null &&
    t.retiredAt === null &&
    t.autoReply &&
    topicApplies(t, i.sender.kind);
  if (!topicOk) return fail(EXIT_REASONS.topic);

  // 6. Reports, never commits: only a question.
  if (i.classification.kind !== 'question') return fail(EXIT_REASONS.notQuestion);

  return { ok: true };
}
