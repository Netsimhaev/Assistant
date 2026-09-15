/**
 * What the curator is shown, assembled in code.
 *
 * The brief carries external content — a supplier's document summary, the
 * body of a message that went out — so the curator is a quarantine reader in
 * the same sense `know.reader` is: its input is hostile by definition and it
 * holds no classified tool.
 *
 * `touched` is the important half. It is the set of subjects this job
 * actually addressed, derived from the plan's own steps, and Task 3's
 * validation refuses any candidate whose subject falls outside it. Built
 * here rather than in the validator because only this module reads the plan.
 */
import type { Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { loadJob } from '../orchestrator/jobs.js';
import { loadPlanBody } from '../orchestrator/plan-store.js';
import { readEmails } from '../policy/facts.js';

export interface TouchedSubjects {
  /** Addresses the plan's outgoing steps were aimed at. */
  recipients: string[];
  /** Entity ids the plan's payloads named. */
  entityIds: string[];
}

export interface CurationBrief {
  text: string;
  touched: TouchedSubjects;
}

/**
 * Whole sections are dropped rather than cut mid-sentence, the same choice
 * `renderReadingBrief` makes: half a section is neither in nor out, and a
 * model asked to summarise half a sentence invents the other half.
 */
export const MAX_BRIEF_CHARS = 12_000;

export async function buildCurationBrief(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<CurationBrief | null> {
  const businessId = options.businessId ?? config.businessId;
  const dbOption = options.db === undefined ? {} : { db: options.db };

  const job = await loadJob(jobId, { businessId, ...dbOption });
  if (job === null) return null;

  const stored = await loadPlanBody(jobId, { businessId, ...dbOption });
  if (stored === null) return null;

  const recipients = new Set<string>();
  const entityIds = new Set<string>();
  const title = job.title ?? '(ללא כותרת)';
  const sections: string[] = [`# המשימה\n${title}`];

  for (const step of stored.plan.steps) {
    for (const address of readEmails(step.input)) recipients.add(address);

    const entityId = step.input['entityId'];
    if (typeof entityId === 'string' && entityId.trim() !== '') entityIds.add(entityId);

    const body = step.input['body'];
    if (typeof body === 'string' && body.trim() !== '') {
      sections.push(`# מה נשלח (${step.toolName})\n${body}`);
    }
  }

  let text = sections.join('\n\n');
  if (text.length > MAX_BRIEF_CHARS) {
    const marker = '\n\n[קוצץ]';
    const kept: string[] = [];
    let used = 0;
    for (const section of sections) {
      const addedLength = (kept.length > 0 ? 2 : 0) + section.length;
      if (used + addedLength + marker.length > MAX_BRIEF_CHARS) break;
      kept.push(section);
      used += addedLength;
    }
    text = `${kept.join('\n\n')}${marker}`;
  }

  return {
    text,
    touched: { recipients: [...recipients], entityIds: [...entityIds] },
  };
}
