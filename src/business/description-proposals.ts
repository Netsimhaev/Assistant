/**
 * Rule proposals from the owner's business description (pure).
 *
 * The model reads the description and returns a JSON array; each item quotes
 * one sentence of the owner and classifies it like stage 10 of the setup
 * interview. This module keeps an item only if:
 *   - its quoted sentence appears in the description (whitespace-insensitive,
 *     Latin case-insensitive) — a paraphrase is dropped, because the rule text
 *     must be the owner's own words;
 *   - the rule text is the ORIGINAL substring of the description (its own
 *     bytes, trimmed), never the model's quote;
 *   - the sentence was not rejected before, is not already pending/accepted,
 *     and was not quoted by an earlier item;
 *   - `parseRuleProposal` builds a real rule from it — guidance (including
 *     every fallback to guidance) constrains nothing and is dropped.
 * At most `DESCRIPTION_PROPOSALS_MAX`, in the model's order.
 */
import type { AcceptedRule } from '../charter/interview/answers.js';
import { parseRuleProposal } from '../charter/interview/rule-proposal.js';
import { extractJsonObjects } from '../util/json-extract.js';
import { normaliseSentence, sentenceHash } from './sentence.js';

export const DESCRIPTION_PROPOSALS_MAX = 10;

/** Returns the model's raw text, so parsing stays testable without the SDK. */
export type DescriptionProposer = (description: string) => Promise<string>;

export interface ProposalExclusions {
  rejectedHashes: ReadonlySet<string>;
  existingTexts: readonly string[];
}

/** Same cap as `AcceptedRule.text`. */
const RULE_TEXT_MAX = 500;

interface NormalisedText {
  text: string;
  /** For each normalised code unit: [start, end) in the original string. */
  spans: Array<[number, number]>;
}

/**
 * Normalise like `normaliseSentence` (whitespace runs → one space, Latin
 * lower-cased) while recording where each normalised unit came from. Not
 * trimmed: a leading/trailing space never matches a trimmed quote's edge.
 */
function normaliseWithMap(original: string): NormalisedText {
  let text = '';
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < original.length) {
    const ch = original[i] as string;
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < original.length && /\s/.test(original[j] as string)) j += 1;
      text += ' ';
      spans.push([i, j]);
      i = j;
    } else {
      text += /[A-Z]/.test(ch) ? ch.toLowerCase() : ch;
      spans.push([i, i + 1]);
      i += 1;
    }
  }
  return { text, spans };
}

/** The description's own substring for `quote`, trimmed, or null when absent. */
export function locateSentence(description: string, quote: string): string | null {
  const q = normaliseSentence(quote);
  if (q.length === 0) return null;
  const norm = normaliseWithMap(description);
  const at = norm.text.indexOf(q);
  if (at === -1) return null;
  const first = norm.spans[at];
  const last = norm.spans[at + q.length - 1];
  if (first === undefined || last === undefined) return null;
  return description.slice(first[0], last[1]).trim();
}

function modelItems(raw: string): unknown[] {
  const stripped = raw.replace(/```(?:json)?/g, '').trim();
  try {
    const parsed: unknown = JSON.parse(stripped);
    if (Array.isArray(parsed)) return parsed;
    if (parsed !== null && typeof parsed === 'object') return [parsed];
  } catch {
    // Not a bare JSON document — fall through to the object stream.
  }
  return extractJsonObjects(raw);
}

export function parseDescriptionProposals(
  raw: string,
  description: string,
  exclude: ProposalExclusions,
): AcceptedRule[] {
  const existing = new Set(exclude.existingTexts.map((t) => normaliseSentence(t)));
  const seen = new Set<string>();
  const out: AcceptedRule[] = [];

  for (const item of modelItems(raw)) {
    if (out.length >= DESCRIPTION_PROPOSALS_MAX) break;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const { sentence, ...rest } = item as Record<string, unknown>;
    if (typeof sentence !== 'string') continue;

    const text = locateSentence(description, sentence);
    if (text === null || text.length === 0 || text.length > RULE_TEXT_MAX) continue;

    const key = normaliseSentence(text);
    if (seen.has(key) || existing.has(key) || exclude.rejectedHashes.has(sentenceHash(text))) continue;

    const rule = parseRuleProposal(JSON.stringify(rest), text);
    if (rule.kind === 'guidance') continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
}
