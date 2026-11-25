/**
 * Pure parser of the quarantined topic clusterer's answer. The model only
 * proposes groups; this code counts, filters and decides. Anything unreadable
 * is `[]`, never a permissive default (owner ruling H7/H8).
 */
import { z } from 'zod';
import { stripBidiControls, toOneLine } from '../util/bidi.js';
import { normaliseName, type NewTopicPayload } from './contact-suggestions.js';
import { TIER2_SOURCE_NAMES, type Tier2SourceName } from './contact-topics.js';

export const NEW_TOPIC_MIN_DECISIONS = 5;
/** H8: cost, margin, discount, buy price, commission, pay — never a topic. */
export const H8_WORDS: readonly string[] = ['עלות', 'רווח', 'מרווח', 'הנחה', 'מחיר קנייה', 'עמלה', 'שכר'];

const NAME_MIN = 2;
const NAME_MAX = 40;
const DESCRIPTION_MAX = 200;

const RawClusters = z
  .object({
    groups: z.array(
      z
        .object({
          name: z.string(),
          description: z.string(),
          indexes: z.array(z.number().int()),
        })
        .strict(),
    ),
  })
  .strict();

export interface ClusterRow {
  decisionId: string;
  sourceNames: string[];
  approved: boolean;
  contactKind: 'client' | 'supplier' | 'unknown';
}
export interface ClusterContext {
  rows: readonly ClusterRow[];
  existingTopicNames: readonly string[];
  contactNames: readonly string[];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-word match. `prefixes` is the set of Hebrew one-letter particles that
 * may stick to the front ("לרונית"); an empty set means a strict word.
 */
function hasWord(text: string, word: string, prefixes: string): boolean {
  const w = escapeRe(word.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ')).replace(/ /g, '\\s+');
  if (w.length === 0) return false;
  const pre = prefixes.length === 0 ? '' : `[${prefixes}]{0,2}`;
  return new RegExp(`(?<![\\p{L}\\p{N}])${pre}${w}(?![\\p{L}\\p{N}])`, 'u').test(text.normalize('NFKC').toLowerCase());
}

/**
 * H8 is SUBSTRING containment on stems, deliberately strict: it catches plurals
 * and construct forms ("עלויות", "הנחות", "מחיר הקנייה"). A false positive only
 * loses one suggestion (the owner can create the topic by hand), so it also
 * drops "בעלות" (ownership) and "השכרה" (rental) topics — accepted.
 */
export const H8_STEMS: readonly string[] = ['עלות', 'עלוי', 'רווח', 'הנחה', 'הנחות', 'מחיר קני', 'מחיר הקני', 'עמל', 'שכר'];
const NAME_PREFIXES = 'ולכבמהש';

function touchesH8(text: string): boolean {
  const t = stripBidiControls(text).normalize('NFKC').toLowerCase().replace(/s+/g, ' ');
  return H8_STEMS.some((stem) => t.includes(stem));
}

function appliesToOf(kinds: Set<string>): NewTopicPayload['appliesTo'] | null {
  const c = kinds.has('client');
  const s = kinds.has('supplier');
  if (c && s) return 'both';
  if (c) return 'client';
  if (s) return 'supplier';
  return null;
}

export function parseClusters(raw: unknown, ctx: ClusterContext): NewTopicPayload[] {
  const parsed = RawClusters.safeParse(raw);
  if (!parsed.success) return [];
  const existing = new Set(ctx.existingTopicNames.map(normaliseName));
  const used = new Set<number>();
  const out: NewTopicPayload[] = [];
  for (const g of parsed.data.groups) {
    const idx = new Set<number>();
    for (const i of g.indexes) {
      if (i < 0 || i >= ctx.rows.length || used.has(i)) continue;
      idx.add(i);
    }
    if (idx.size < NEW_TOPIC_MIN_DECISIONS) continue;
    const name = toOneLine(stripBidiControls(g.name));
    const description = toOneLine(stripBidiControls(g.description));
    if (name.length < NAME_MIN || name.length > NAME_MAX || description.length > DESCRIPTION_MAX) continue;
    const text = `${name}\n${description}`;
    if (touchesH8(text)) continue;
    if (ctx.contactNames.some((n) => hasWord(text, n, NAME_PREFIXES))) continue;
    const key = normaliseName(name);
    if (existing.has(key)) continue;
    const members = [...idx].sort((a, b) => a - b).map((i) => ctx.rows[i] as ClusterRow);
    const appliesTo = appliesToOf(new Set(members.map((m) => m.contactKind)));
    if (appliesTo === null) continue;
    // Only a kept group consumes its indexes and its name.
    for (const i of idx) used.add(i);
    existing.add(key);
    const sources = new Set<Tier2SourceName>();
    for (const m of members) {
      if (!m.approved) continue;
      for (const s of m.sourceNames) {
        if ((TIER2_SOURCE_NAMES as readonly string[]).includes(s)) sources.add(s as Tier2SourceName);
      }
    }
    out.push({ name, description, appliesTo, sources: [...sources], decisionIds: members.map((m) => m.decisionId) });
  }
  return out;
}
