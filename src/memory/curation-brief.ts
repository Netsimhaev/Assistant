/**
 * What the curator is shown, assembled in code.
 *
 * The brief carries external content — the summary and findings of a
 * document the job read, the body of a message that went out — so the
 * curator is a quarantine reader in the same sense `know.reader` is: its
 * input is hostile by definition and it holds no classified tool.
 *
 * `touched` is the important half. It is the set of subjects this job
 * actually addressed, derived from the plan's own steps and, when the job
 * read a document, from that reading's own entity-kind intents. Task 3's
 * validation refuses any candidate whose subject falls outside it. Built
 * here rather than in the validator because only this module reads the plan
 * and the reading together.
 */
import type { Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { addresseeOf } from '../domain/action.js';
import type { Reading } from '../domain/reading.js';
import { loadJob } from '../orchestrator/jobs.js';
import { loadPlanBody } from '../orchestrator/plan-store.js';
import { classifyAction, refineActionClass } from '../policy/classify.js';
import { readEmails } from '../policy/facts.js';

export interface TouchedSubjects {
  /** Addresses the plan's outgoing steps were aimed at. */
  recipients: string[];
  /** Entity ids the plan's payloads named, plus any the job's reading identified. */
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

/**
 * Whether this step's payload names somebody it wrote *to*, as opposed to
 * somebody it merely mentions.
 *
 * `isOutbound` (`src/policy/classify.ts`) answers a different question —
 * "does this leave the instance" — and answers it `true` for `crm.write`,
 * which does reach a third-party CRM. But `crm.write`'s `email` field is the
 * new lead's address, i.e. the record's *content*, never a destination: see
 * the `messagesAPerson` comment in `src/policy/risk.ts` and the crm.write
 * note in CLAUDE.md ("§28/08 review"). `addresseeOf` is what the rest of the
 * codebase already asks this exact question with — `scoreVisibility` reads
 * it for the identical reason. An unclassified tool answers `false`: a name
 * nobody classified is a name nobody vouched for as reaching a person.
 */
function stepAddressesPerson(toolName: string, input: Record<string, unknown>): boolean {
  const base = classifyAction(toolName);
  if (base === null) return false;
  return addresseeOf(refineActionClass(base, input)) === 'person';
}

/**
 * The most recent reading behind this job, if any.
 *
 * Follows the same chain `documentForApproval` walks — `proposals.job_id →
 * proposals.reading_id → document_readings` — because that is how a job
 * reaches a reading at all; there is no direct foreign key from `jobs` to
 * `document_readings`. Ordered and limited exactly as that query is
 * (`created_at DESC, proposal_id DESC LIMIT 1`), for the same reason: a job
 * may carry more than one proposal over time, and the brief should reflect
 * the latest one, not an arbitrary one. Neither the proposal's `status` nor
 * the reading's is filtered on — an `unproposable` proposal still names a
 * real reading of a real document, which is exactly what belongs in a brief
 * about what this job actually did.
 *
 * Returns `null` both when the job has no proposal at all (the ordinary
 * case — most jobs never read anything) and when the reading it names came
 * back `unreadable` and so carries no `content`. Both collapse to "nothing
 * to add", not an error.
 */
async function loadReadingForJob(
  jobId: string,
  options: { businessId: string; db: Queryable },
): Promise<Reading | null> {
  const { rows } = await options.db.query<{ content: unknown }>(
    `SELECT r.content
       FROM proposals p
       JOIN document_readings r
         ON r.reading_id = p.reading_id AND r.business_id = p.business_id
      WHERE p.job_id = $1 AND p.business_id = $2
      ORDER BY p.created_at DESC, p.proposal_id DESC
      LIMIT 1`,
    [jobId, options.businessId],
  );
  const row = rows[0];
  if (row === undefined || row.content === null || row.content === undefined) return null;
  // Stored as validated JSON, read back without re-validation — the same
  // convention `reading-store.ts`'s own `toReading` follows: what went in
  // passed `Reading.safeParse` at the boundary already.
  return row.content as Reading;
}

export async function buildCurationBrief(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<CurationBrief | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const job = await loadJob(jobId, { businessId, db });
  if (job === null) return null;

  const stored = await loadPlanBody(jobId, { businessId, db });
  if (stored === null) return null;

  const recipients = new Set<string>();
  const entityIds = new Set<string>();
  const title = job.title ?? '(ללא כותרת)';
  const sections: string[] = [`# המשימה\n${title}`];

  for (const step of stored.plan.steps) {
    if (stepAddressesPerson(step.toolName, step.input)) {
      for (const address of readEmails(step.input)) recipients.add(address);
    }

    const entityId = step.input['entityId'];
    if (typeof entityId === 'string' && entityId.trim() !== '') entityIds.add(entityId);

    const body = step.input['body'];
    if (typeof body === 'string' && body.trim() !== '') {
      sections.push(`# מה נשלח (${step.toolName})\n${body}`);
    }
  }

  const reading = await loadReadingForJob(jobId, { businessId, db });
  if (reading !== null) {
    sections.push(`# מה נקרא במסמך\n${reading.summary}`);
    if (reading.findings.length > 0) {
      sections.push(
        `# ממצאים\n${reading.findings.map((finding) => `${finding.label}: ${finding.value}`).join('\n')}`,
      );
    }
    for (const intent of reading.intents) {
      if (intent.subject.kind === 'entity') entityIds.add(intent.subject.entityId);
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
