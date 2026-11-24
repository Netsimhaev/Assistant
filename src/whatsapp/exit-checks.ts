/**
 * The six exit checks a drafted auto-reply must pass before it may go out
 * without the owner's approval (phase 2, package 1; owner ruling P3).
 *
 * Pure. Every check is positive ("allowed when X"); the first failure wins,
 * and a value that cannot be read is never the permissive one.
 */
import { ungroundedNumbers } from '../governance/numeric-grounding.js';
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

/** Drops invisible format characters (zero-width, bidi), then NFKC, then collapses whitespace. */
function normalise(text: string): string {
  return text.replace(/\p{Cf}/gu, '').normalize('NFKC').replace(/\s+/g, ' ');
}

/** Digits only; a local leading 0 becomes 972. Empty when there are no digits. */
function phoneDigits(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return `972${d.slice(1)}`;
  return d;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentionsName(draftLower: string, nameLower: string): boolean {
  // Whole word; a Hebrew one-letter particle may stick to the front ("לרונית").
  const re = new RegExp(`(?<![\\p{L}\\p{N}])[ולכבמהש]{0,2}${escapeRe(nameLower)}(?![\\p{L}\\p{N}])`, 'u');
  return re.test(draftLower);
}

/** Every maximal ASCII digit run, thousands commas removed, leading zeros dropped. */
function digitRuns(text: string): string[] {
  let t = text;
  for (;;) {
    const next = t.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
    if (next === t) break;
    t = next;
  }
  return (t.match(/\d+/g) ?? []).map((r) => r.replace(/^0+(?=\d)/, ''));
}

// Dates and times must also match as a unit. '.' is read as '/' only for a
// full d/m/yyyy: a source decimal ("3.11") never grounds a draft "3/11".
const DATE_OR_TIME = /(?<![\d/.:])\d{1,2}(?:[/.]\d{1,2}(?:[/.]\d{2,4})?|:\d{2})(?![\d/:])/g;

function dateTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DATE_OR_TIME)) {
    let tok = m[0];
    if (/^\d+\.\d+\.\d+$/.test(tok)) tok = tok.replace(/\./g, '/');
    out.push(tok.split(/([/:.])/).map((p) => (/^\d+$/.test(p) ? String(Number(p)) : p)).join(''));
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

function numbersGrounded(draft: string, sources: readonly string[]): boolean {
  if (sources.length === 0) return !/\p{Nd}/u.test(draft);
  if (/\p{Nd}/u.test(draft.replace(/[0-9]/g, ''))) return false; // non-ASCII digit survived NFKC
  const known = new Set(sources.flatMap(digitRuns));
  if (!digitRuns(draft).every((r) => known.has(r))) return false;
  if (ungroundedNumbers(draft, sources).length > 0) return false;
  return datesGrounded(draft, sources);
}

export function exitChecks(i: ExitCheckInput): ExitCheckResult {
  if (i.sourceFailed || i.ownershipViolation) return fail(EXIT_REASONS.sources);

  const draft = normalise(i.draft);

  // 1. Every digit run in the draft must appear in a source (the shared
  // ungroundedNumbers() skips dates, ranges, urls and grounds an empty list).
  if (!numbersGrounded(draft, i.tier12.map((t) => normalise(t.text)))) return fail(EXIT_REASONS.ungrounded);

  // 2. No other person.
  const draftLower = draft.toLowerCase();
  const senderName = normalise(i.sender.name).toLowerCase().trim();
  for (const raw of i.otherPeople.names) {
    const name = normalise(raw).toLowerCase().trim();
    if (name.length < 2 || name === senderName) continue;
    if (mentionsName(draftLower, name)) return fail(EXIT_REASONS.otherPerson);
  }
  for (const raw of i.otherPeople.emails) {
    const email = raw.toLowerCase().trim();
    if (email !== '' && draftLower.includes(email)) return fail(EXIT_REASONS.otherPerson);
  }
  // Digits of the whole draft run together, so a phone cannot hide next to
  // another number; the key is matched by its last 9 digits (local 0 or 972).
  const draftDigits = draft.replace(/\D/g, '');
  for (const raw of i.otherPeople.phoneKeys) {
    const key = phoneDigits(raw);
    if (key === '') continue;
    if (draftDigits.includes(key.length > 9 ? key.slice(-9) : key)) return fail(EXIT_REASONS.otherPerson);
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
