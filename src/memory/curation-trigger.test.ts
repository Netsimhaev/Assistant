import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Plan } from '../domain/plan.js';
import { jobQualifiesForCuration } from './curation-trigger.js';

function planWith(toolNames: string[]): Plan {
  return {
    goal: 'test',
    steps: toolNames.map((toolName, i) => ({
      id: `s${i}`,
      agent: 'comm.mail' as const,
      intent: 'test',
      toolName,
      input: {},
      dependsOn: [],
      expectedActionClass: null,
    })),
  } as unknown as Plan;
}

describe('which jobs the curator runs on', () => {
  it('runs on a job that read external content', () => {
    expect(jobQualifiesForCuration(planWith(['doc.fetch']))).toBe(true);
  });

  it('runs on a job that communicated', () => {
    expect(jobQualifiesForCuration(planWith(['mail.send']))).toBe(true);
  });

  it('does not run on a job that neither read nor communicated', () => {
    // Both of these are outside BOTH tables — verified against classify.ts,
    // not assumed. An earlier draft of this plan used `crm.write` and
    // `memory.recall` here and was wrong on both: `crm.write` IS outbound
    // (it reaches a third-party SaaS host) and `memory.recall` DOES ingest
    // (recalled memory can carry an external claim).
    expect(jobQualifiesForCuration(planWith(['mail.draft', 'tasks.update_state']))).toBe(false);
  });

  it('does not run on an empty plan', () => {
    expect(jobQualifiesForCuration(planWith([]))).toBe(false);
  });

  /**
   * The predicate must DERIVE from the two tables that already define "reads"
   * and "communicates". A second hand-written list is a definition that drifts
   * from the first, which has happened three times in this codebase.
   */
  it('names no tool literally — it derives from the classification tables', async () => {
    const source = await readFile(new URL('./curation-trigger.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export function jobQualifiesForCuration'));
    expect(body).not.toMatch(/'[a-z]+\.[a-z_]+'/);
  });
});
