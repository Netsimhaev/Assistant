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
import { messagesAPerson } from '../domain/action.js';
import type { Reading } from '../domain/reading.js';
import { mailForJob } from '../mail/inbox-store.js';
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
 * which does reach a third-party CRM. `messagesAPerson`
 * (`src/domain/action.ts`) is what the rest of the codebase already asks
 * this exact question with — `scoreVisibility` (`src/policy/risk.ts`) reads
 * it for the identical reason, and its own docblock carries the `crm.write`
 * case in full: that tool's `email` field is a lead's address, i.e. the
 * record's content, never a destination. An unclassified tool answers
 * `false`: a name nobody classified is a name nobody vouched for as
 * reaching a person.
 *
 * Refined through `refineActionClass` before the check, the same as the
 * gate itself does (`buildFacts`, `src/policy/facts.ts`), rather than
 * reading `classifyAction`'s base class directly. No current
 * `REFINEMENT_RULES` entry actually flips a class between addressing a
 * person and not — `email.reply`/`email.initiate`,
 * `whatsapp.reply`/`whatsapp.initiate` and the `calendar.*` family are all
 * `person` either way, so refining changes nothing today. It stays
 * future-proof against the day a refinement rule does flip that answer:
 * reading the base class here while the gate reads the refined one would
 * then silently disagree about whether the same step addressed a person.
 */
function stepAddressesPerson(toolName: string, input: Record<string, unknown>): boolean {
  const base = classifyAction(toolName);
  if (base === null) return false;
  return messagesAPerson(refineActionClass(base, input));
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

/**
 * The brief for a mail's triage job, which has no plan.
 *
 * `touched` is exactly the sender address, read from the stored header — never
 * from the model's summary, which is a model's rendering of hostile text. A
 * mail with no sender address touches nobody and yields no brief.
 */
async function buildMailBrief(
  jobId: string,
  title: string | null,
  options: { businessId: string; db: Queryable },
): Promise<CurationBrief | null> {
  const mail = await mailForJob(jobId, options);
  if (mail === null) return null;
  const sender = mail.fromAddress.trim();
  if (sender === '') return null;
  const sections = [
    `# המשימה\n${title ?? '(ללא כותרת)'}`,
    `# נושאים מותרים\n` +
      `מותר לך לכתוב עובדה רק על מי שמזהה אותו מופיע ברשימה הזו, ` +
      `ו-subjectKey חייב להיות זהה למזהה כאן אות באות — לא שם, לא ניחוש:\n- ${sender}`,
    `# סוג המייל\n${mail.categories.join(', ')}`,
    `# סיכום המייל\n${mail.summary ?? ''}`,
  ];
  let text = sections.join('\n\n');
  if (text.length > MAX_BRIEF_CHARS) text = `${text.slice(0, MAX_BRIEF_CHARS)}\n\n[קוצץ]`;
  return { text, touched: { recipients: [sender], entityIds: [] } };
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
  if (stored === null) return buildMailBrief(jobId, job.title, { businessId, db });

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

  // The set of subjects `siftCandidates` will accept is per-job — it cannot
  // live in `SYSTEM_PROMPT` (the cached prefix) without invalidating the
  // cache on every call, the same reasoning `PlanRequest.instruction`'s
  // docblock (`src/sdk/planner.ts`) gives for keeping a per-call value out of
  // the system prompt. So it is rendered here, into the brief, verbatim —
  // the exact strings `siftCandidates` compares against, not a paraphrase.
  const permittedSubjects = [...recipients, ...entityIds];
  const permittedSection =
    permittedSubjects.length > 0
      ? `# נושאים מותרים\n` +
        `מותר לך לכתוב עובדה רק על מי שמזהה אותו מופיע ברשימה הזו, ` +
        `ו-subjectKey חייב להיות זהה למזהה כאן אות באות — לא שם, לא ניחוש:\n` +
        permittedSubjects.map((subject) => `- ${subject}`).join('\n')
      : `# נושאים מותרים\n` +
        `המשימה הזו לא פנתה אל אף אחד ולא נקבה בשם ישות — אין אף נושא שמותר ` +
        `לכתוב עליו עובדה, ולכן התשובה התקנית היחידה היא {"candidates":[]}.`;
  // Inserted right after the title, not appended at the end: `text` below is
  // truncated by dropping whole trailing sections when it exceeds
  // MAX_BRIEF_CHARS, and a section this small and this load-bearing must
  // never be among the ones a long reading pushes out.
  sections.splice(1, 0, permittedSection);

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
