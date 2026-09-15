/**
 * What the assistant decides to remember, on her own, when a job ends.
 *
 * This writes memory DIRECTLY and never through the gate, and the spec
 * argues why at length (§3): stage 8 holds the memory class at `draft_only`
 * for `unknown_external`, so curation through a tool would write nothing from
 * exactly the documents the owner decided must be remembered — labelled.
 * Three positive controls stand in for the gate: provenance read from the job
 * row (inside `writeMemory`), the subject required to be one the job actually
 * touched (`siftCandidates`), and the label travelling with the row into
 * every recall.
 *
 * Nothing here can fail a job. A job that did its work and cannot be closed
 * because a model did not answer is a bug, not a control.
 */
import type { Queryable } from '../db/pool.js';
import { getPool } from '../db/pool.js';
import { config } from '../config.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import { loadPlanBody } from '../orchestrator/plan-store.js';
import { curateWithModel, type Curator } from '../sdk/curator.js';
import { buildCurationBrief } from './curation-brief.js';
import { siftCandidates, type CurationCandidate } from './curation-parse.js';
import { jobQualifiesForCuration } from './curation-trigger.js';
import { recallMemories, writeMemory } from './store.js';

export interface CurationOutcome {
  ran: boolean;
  skipped: 'not_qualified' | 'no_plan' | 'no_key' | 'over_cap' | null;
  written: number;
  rejected: number;
}

export interface CurateJobOptions {
  businessId?: string;
  /** Injected by tests. Production leaves it unset and gets the billed call. */
  curator?: Curator;
}

/**
 * The daily ceiling counts AUDIT rows, not `memories` rows.
 *
 * `memories` carries no column saying who wrote a row — `written_by_job`
 * names a job, not a curator — so counting there could not tell a row the
 * curator wrote from one a plan's `memory.write_*` step wrote, and a ceiling
 * meant to fence billed calls would have been closed by writes that cost
 * nothing. Counting audit rows also counts a call that returned no
 * candidates, which is precisely a call that was paid for.
 */
export async function curationRunsToday(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<number> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log
      WHERE business_id = $1 AND kind = 'curation' AND at >= date_trunc('day', now())`,
    [businessId],
  );
  return Number(rows[0]?.n ?? '0');
}

export async function curateJob(
  jobId: string,
  options: CurateJobOptions = {},
): Promise<CurationOutcome> {
  const businessId = options.businessId ?? config.businessId;
  const idle: CurationOutcome = { ran: false, skipped: null, written: 0, rejected: 0 };

  const stored = await loadPlanBody(jobId, { businessId });
  if (stored === null) return { ...idle, skipped: 'no_plan' };
  if (!jobQualifiesForCuration(stored.plan)) return { ...idle, skipped: 'not_qualified' };

  // Same switch discipline as DOCUMENT_INBOX: no key means the feature is off,
  // reported rather than silently identical to "nothing to remember".
  if (options.curator === undefined && (process.env['ANTHROPIC_API_KEY'] ?? '') === '') {
    return { ...idle, skipped: 'no_key' };
  }
  if ((await curationRunsToday({ businessId })) >= config.curationRunsPerDay) {
    return { ...idle, skipped: 'over_cap' };
  }

  const brief = await buildCurationBrief(jobId, { businessId });
  if (brief === null) return { ...idle, skipped: 'no_plan' };

  const curator = options.curator ?? curateWithModel;

  let written = 0;
  let rejected = 0;
  try {
    const result = await curator(brief);
    const sifted = siftCandidates(result, brief.touched);
    rejected = sifted.rejected.length;

    for (const candidate of sifted.accepted) {
      const resolved = await resolveConflict(candidate, jobId, businessId);
      await writeMemory(
        {
          jobId,
          kind: resolved.kind,
          subjectKey: candidate.subjectKey,
          ...(resolved.kind === 'preference' ? { attribute: candidate.attribute ?? null } : {}),
          body: resolved.body,
          sourceRef: candidate.sourceRef,
        },
        { businessId },
      );
      written += 1;
    }
  } catch {
    // The job is finished either way. A curator that throws must not strand it.
    return { ...idle, written, rejected };
  }

  await appendAudit(
    {
      actor: 'orchestrator',
      kind: 'curation',
      charterVersion: 'n/a',
      provenance: 'boss',
      // Counts only. A subject here would put the contact's identity into the
      // one table an erasure deliberately cannot reach.
      inputHash: canonicalHash({ jobId, written, rejected }),
      artifacts: [],
      costMinor: null,
      tokens: null,
      reason: `אצירה · ${written} עובדות נשמרו · ${rejected} נדחו`,
    },
    { businessId },
  );

  return { ran: true, skipped: null, written, rejected };
}

/**
 * Decision 3, expressed in the schema's terms.
 *
 * `memories` carries partial unique indexes: one live entity per subject, one
 * live preference per `(subject, attribute)`. "Both alive side by side" is
 * therefore not a state the schema permits, so an external claim that
 * contradicts something the OWNER said is written as a `chunk` instead —
 * which carries no uniqueness. The owner's row stays the live fact and the
 * supplier's claim is recorded as what it is.
 */
async function resolveConflict(
  candidate: CurationCandidate,
  jobId: string,
  businessId: string,
): Promise<{ kind: 'entity' | 'preference' | 'chunk'; body: Record<string, unknown> }> {
  if (candidate.kind === 'chunk') return { kind: 'chunk', body: candidate.body };

  const { rows } = await getPool().query<{ provenance: string }>(
    'SELECT provenance FROM jobs WHERE job_id = $1 AND business_id = $2',
    [jobId, businessId],
  );
  const incoming = rows[0]?.provenance;

  const live = await recallMemories(
    { subjectKey: candidate.subjectKey, kind: candidate.kind },
    { businessId },
  );
  const existing = live.find(
    (m) => m.kind !== 'preference' || m.attribute === (candidate.attribute ?? null),
  );

  if (existing?.provenance === 'boss' && incoming !== 'boss') {
    return {
      kind: 'chunk',
      body: {
        claim: candidate.body,
        about: candidate.attribute ?? candidate.subjectKey,
        note: 'טענה חיצונית שסותרת את מה שהבעלים אמר — נשמרה כטענה ולא כעובדה',
      },
    };
  }

  return { kind: candidate.kind, body: candidate.body };
}
