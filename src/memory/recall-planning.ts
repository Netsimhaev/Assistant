/**
 * The past, assembled in code and handed to the planner.
 *
 * Not a tool the model calls and not a search it steers: `docs/06-memory.md`
 * rejects a general `search_everything` by name as unbounded in cost and
 * impossible to audit. The caller names the subjects; this returns text.
 *
 * Two rules carry the safety. Scope is positive — only the subjects this job
 * touches, so a stranger's claim cannot surface in a plan that has nothing to
 * do with them. And every row whose provenance is not `boss` is rendered as an
 * attributed claim, in the renderer and not as an instruction in the prompt,
 * because that is the difference between influence and an injection that
 * worked.
 *
 * Rows are pooled from all subjects, then sorted by provenance (owner facts
 * first, external claims last). Within each tier, rows keep the order their
 * subjects were named. If the first subject's facts fill the budget, later
 * subjects may not appear at all — the block is filled in subject order, and
 * the character budget is the hard stop.
 */
import { config } from '../config.js';
import { recallMemories, MAX_RECALL, type MemoryRecord } from './store.js';

export const MEMORY_BLOCK_BUDGET_CHARS = 3_000;

function renderRow(memory: MemoryRecord): string {
  const value = JSON.stringify(memory.body);
  if (memory.provenance === 'boss') {
    return `- ${memory.subjectKey}${memory.attribute ? ` · ${memory.attribute}` : ''}: ${value}`;
  }
  const source = memory.sourceRef === null ? '' : ` (${memory.sourceRef})`;
  return `- ${memory.subjectKey}: נטען${source} — ${value}`;
}

export async function recallForPlanning(
  subjects: string[],
  options: { businessId?: string; budget?: number } = {},
): Promise<string> {
  const businessId = options.businessId ?? config.businessId;
  const budget = options.budget ?? MEMORY_BLOCK_BUDGET_CHARS;

  const found: MemoryRecord[] = [];
  for (const subject of subjects) {
    found.push(...(await recallMemories({ subjectKey: subject, limit: MAX_RECALL }, { businessId })));
  }
  if (found.length === 0) return '';

  // Least important out first: external claims go before the owner's facts.
  const ordered = [...found].sort((a, b) => {
    const rank = (m: MemoryRecord): number => (m.provenance === 'boss' ? 0 : 1);
    return rank(a) - rank(b);
  });

  const header = '# מה ידוע מהעבר';
  const lines: string[] = [];
  let used = header.length;
  for (const memory of ordered) {
    const line = renderRow(memory);
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return '';

  return `${header}\n${lines.join('\n')}`;
}
