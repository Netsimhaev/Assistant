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
 * because a model did not answer is a bug, not a control — the whole body
 * below (plan lookup, cap check, brief, model call, writes) runs inside one
 * `try`, and the `catch` at the bottom always resolves, never rethrows. A
 * failure still leaves a trace: it writes the same `curation` audit row a
 * success does, so the daily cap advances for a call that was paid for even
 * when the model never answered, and `CurationOutcome.failed` says plainly
 * that something went wrong rather than reading like a quiet no-op.
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
import { writeMemory } from './store.js';

export interface CurationOutcome {
  ran: boolean;
  skipped: 'not_qualified' | 'no_plan' | 'no_brief' | 'no_key' | 'over_cap' | null;
  written: number;
  rejected: number;
  /** True when something threw partway through — a bug or an outage, never a control. */
  failed: boolean;
}

export interface CurateJobOptions {
  businessId?: string;
  /** Injected by tests. Production leaves it unset and gets the billed call. */
  curator?: Curator;
  /** Defaults to `config.curationRunsPerDay`. Injected by tests, same as `ConductOptions.readsPerDay`. */
  runsPerDay?: number;
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
  const idle: CurationOutcome = { ran: false, skipped: null, written: 0, rejected: 0, failed: false };

  let written = 0;
  let rejected = 0;

  // Everything that can throw — plan lookup, the cap query, the brief, the
  // model call, and every write — lives inside this one `try`. Fix round 1
  // (I4) found the first three outside it, which meant `curateJob` could
  // still throw into the caller's `verify → remember` hop: exactly what the
  // header above says cannot happen. The skip returns below (`no_plan`,
  // `not_qualified`, `no_key`, `over_cap`, `no_brief`) are ordinary early
  // returns, not throws, so none of them touch the `catch`.
  try {
    const stored = await loadPlanBody(jobId, { businessId });
    if (stored === null) return { ...idle, skipped: 'no_plan' };
    if (!jobQualifiesForCuration(stored.plan)) return { ...idle, skipped: 'not_qualified' };

    // Same switch discipline as DOCUMENT_INBOX: no key means the feature is
    // off, reported rather than silently identical to "nothing to remember".
    if (options.curator === undefined && (process.env['ANTHROPIC_API_KEY'] ?? '') === '') {
      return { ...idle, skipped: 'no_key' };
    }
    const runsPerDay = options.runsPerDay ?? config.curationRunsPerDay;
    if ((await curationRunsToday({ businessId })) >= runsPerDay) {
      return { ...idle, skipped: 'over_cap' };
    }

    // Distinct from `no_plan` above: a plan IS bound, but a brief could not
    // be built from it (see `buildCurationBrief`'s own null cases). Same
    // shape, different cause — collapsing them was an honesty-of-reporting
    // gap fix round 1 flagged (minor 7).
    const brief = await buildCurationBrief(jobId, { businessId });
    if (brief === null) return { ...idle, skipped: 'no_brief' };

    const curator = options.curator ?? curateWithModel;
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

    await appendAudit(
      {
        actor: 'orchestrator',
        kind: 'curation',
        charterVersion: 'n/a',
        provenance: 'boss',
        // Counts only. A subject here would put the contact's identity into
        // the one table an erasure deliberately cannot reach.
        inputHash: canonicalHash({ jobId, written, rejected }),
        artifacts: [],
        costMinor: null,
        tokens: null,
        reason: `אצירה · ${written} עובדות נשמרו · ${rejected} נדחו`,
      },
      { businessId },
    );

    return { ran: true, skipped: null, written, rejected, failed: false };
  } catch (err) {
    // The job is finished either way — see the header. But a billed call
    // that throws must still leave a trace (fix round 1, I2): otherwise the
    // daily cap never advances for a call that was paid for, and a
    // programming error (a `TypeError` in this module, a lost connection)
    // reads exactly like the model simply declining to answer (I3). Only the
    // error's constructor name is recorded, never its message — a message
    // could echo back a candidate's subject or body, which is exactly what
    // this audit kind must never carry.
    await recordCurationFailure(businessId, jobId, written, rejected, err);
    // `ran` reflects whether any effect actually happened: writes that
    // completed before the failure are real and must not be reported
    // alongside `ran: false`, which fix round 1 (minor 8) called
    // self-contradictory.
    return { ran: written > 0, skipped: null, written, rejected, failed: true };
  }
}

/**
 * Record that a curation attempt failed, without letting the recording
 * itself become a second way to fail the job. Mirrors
 * `recordReadFailureSafely` in `orchestrator/conduct.ts` for the identical
 * reason: the caller already knows the attempt failed, and losing that
 * knowledge is a smaller loss than losing the job over an audit write.
 */
async function recordCurationFailure(
  businessId: string,
  jobId: string,
  written: number,
  rejected: number,
  err: unknown,
): Promise<void> {
  const errorKind = err instanceof Error ? err.constructor.name : 'unknown';
  try {
    await appendAudit(
      {
        actor: 'orchestrator',
        kind: 'curation',
        charterVersion: 'n/a',
        provenance: 'boss',
        inputHash: canonicalHash({ jobId, written, rejected, failed: true, errorKind }),
        artifacts: [],
        costMinor: null,
        tokens: null,
        reason: `אצירה נכשלה · ${written} עובדות נשמרו לפני הכשל · ${rejected} נדחו · שגיאה: ${errorKind}`,
      },
      { businessId },
    );
  } catch {
    // Swallowed on purpose — see the docblock above.
  }
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
 *
 * The lookup below asks the database the question this function actually
 * means — "is there a live row at this exact key" — with a direct query
 * scoped to `(business_id, kind, subject_key, attribute)`, the same key
 * `writeMemory`'s own retire step uses. Fix round 1 (C1) found this done
 * through `recallMemories` instead, which answers a different question
 * ("what do we know about this subject") and pages: default limit 5, newest
 * first, with no `attribute` filter at all. A `boss` preference sitting
 * behind six newer live rows on the same subject was therefore invisible to
 * the guard — the check fell through as `existing === undefined`, and a
 * stranger's claim was written as a competing preference that soft-retired
 * the owner's row. Nothing here is paged: the partial unique index already
 * guarantees at most one live row at this key, so this query can only ever
 * return zero or one.
 */
async function resolveConflict(
  candidate: CurationCandidate,
  jobId: string,
  businessId: string,
): Promise<{ kind: 'entity' | 'preference' | 'chunk'; body: Record<string, unknown> }> {
  if (candidate.kind === 'chunk') return { kind: 'chunk', body: candidate.body };

  const { rows: jobRows } = await getPool().query<{ provenance: string }>(
    'SELECT provenance FROM jobs WHERE job_id = $1 AND business_id = $2',
    [jobId, businessId],
  );
  const incoming = jobRows[0]?.provenance;

  const attribute = candidate.kind === 'preference' ? (candidate.attribute ?? null) : null;
  const { rows: liveRows } = await getPool().query<{ provenance: string }>(
    `SELECT provenance FROM memories
       WHERE business_id = $1 AND kind = $2 AND subject_key = $3
         AND attribute IS NOT DISTINCT FROM $4 AND retired_at IS NULL
       LIMIT 1`,
    [businessId, candidate.kind, candidate.subjectKey, attribute],
  );
  const existing = liveRows[0];

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
