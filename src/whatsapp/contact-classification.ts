/**
 * Pure parser of the quarantined classifier's answer. The model describes; this
 * code decides what survives. Anything unreadable is `unclassified` — never a
 * permissive default.
 */
import { z } from 'zod';
import { stripBidiControls, toOneLine } from '../util/bidi.js';
import { parseIsoInstant } from '../util/send-at.js';
import type { MessageKind } from './card-context.js';

export const COURTESY_MAX_CHARS = 40;
export const SUMMARY_MAX_CHARS = 200;
export const WINDOW_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export interface Classification {
  kind: MessageKind | 'unclassified';
  topicId: string | null;
  summary: string;
  window: { from: Date; to: Date } | null;
}

const RawClassification = z
  .object({
    kind: z.enum(['question', 'request', 'commitment', 'courtesy']),
    topicId: z.string().nullable(),
    summary: z.string(),
    window: z.object({ from: z.unknown(), to: z.unknown() }).strict().nullable(),
  })
  .strict();

export interface ClassificationContext {
  topicIds: ReadonlySet<string>;
  texts: readonly string[];
  now: Date;
}

const UNCLASSIFIED: Classification = { kind: 'unclassified', topicId: null, summary: '', window: null };

function readWindow(
  w: { from?: unknown; to?: unknown } | null,
  now: Date,
): { from: Date; to: Date } | null {
  if (w === null) return null;
  const from = parseIsoInstant(w.from);
  const to = parseIsoInstant(w.to);
  if (from === null || to === null) return null;
  if (from.getTime() >= to.getTime()) return null;
  if (to.getTime() <= now.getTime()) return null;
  if (to.getTime() - from.getTime() > WINDOW_MAX_MS) return null;
  return { from, to };
}

export function parseClassification(raw: unknown, ctx: ClassificationContext): Classification {
  const parsed = RawClassification.safeParse(raw);
  if (!parsed.success) return { ...UNCLASSIFIED };
  const p = parsed.data;
  if (p.kind === 'courtesy' && !ctx.texts.every((t) => t.length <= COURTESY_MAX_CHARS)) {
    return { ...UNCLASSIFIED };
  }
  return {
    kind: p.kind,
    topicId: p.topicId !== null && ctx.topicIds.has(p.topicId) ? p.topicId : null,
    summary: toOneLine(stripBidiControls(p.summary)).slice(0, SUMMARY_MAX_CHARS),
    window: readWindow(p.window, ctx.now),
  };
}
