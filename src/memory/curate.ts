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
import type { BusinessDb } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import { loadPlanBody } from '../orchestrator/plan-store.js';
import { curateWithModel, type Curator } from '../sdk/curator.js';
import { buildCurationBrief, buildExternalBrief } from './curation-brief.js';
import { siftCandidates, type CurationCandidate } from './curation-parse.js';
import { jobQualifiesForCuration } from './curation-trigger.js';
import { writeMemory } from './store.js';
import { capFor, loadRuntimeSettings } from '../tenancy/runtime-settings.js';

export interface CurationOutcome {
  ran: boolean;
  skipped: 'not_qualified' | 'no_plan' | 'no_brief' | 'no_key' | 'over_cap' | null;
  written: number;
  rejected: number;
  /** True when something threw partway through — a bug or an outage, never a control. */
  failed: boolean;
}

export interface CurateJobOptions {
  /** Injected by tests. Production leaves it unset and gets the billed call. */
  curator?: Curator;
  /** Defaults to the business's `curationRunsPerDay` (`capFor`). Injected by tests, same as `ConductOptions.readsPerDay`. */
  runsPerDay?: number;
  /**
   * `mail` curates a mail's planless triage job from its stored summary, with
   * its own audit-row prefix and its own daily count. `external` curates a
   * learning job over external-system events (`external/learn.ts`) from the
   * events' declared fields, likewise with its own prefix and count. Both are
   * chunk-only and never retire. Default is unchanged.
   */
  scope?: CurationScope;
}

export type CurationScope = 'default' | 'mail' | 'external';

/** Each scope's audit-row prefix — what its daily count matches on, positively. */
const SCOPE_PREFIX: Readonly<Record<CurationScope, string>> = {
  default: '',
  mail: 'mail:',
  external: 'ext:',
};

/** Each scope's daily cap, by its `config` / runtime-column name. */
const SCOPE_CAP = {
  default: 'curationRunsPerDay',
  mail: 'mailCurationPerDay',
  external: 'externalCurationPerDay',
} as const satisfies Readonly<Record<CurationScope, string>>;

/** The note a chunk-only scope stores beside a claim it would not let become a fact. */
const CHUNK_NOTE: Readonly<Record<'mail' | 'external', string>> = {
  mail: 'טענה ממייל נכנס — נשמרה כטענה ולא כעובדה',
  external: 'טענה ממערכת חיצונית — נשמרה כטענה ולא כעובדה',
};

/** Every curation audit row's reason starts with its scope prefix and then this word. */
const CURATION_WORD = 'אצירה';

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
  db: BusinessDb,
  options: { scope?: CurationScope } = {},
): Promise<number> {
  const businessId = db.businessId;
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log
      WHERE business_id = $1 AND kind = 'curation' AND at >= date_trunc('day', now())
        AND reason LIKE $2`,
    // A positive match on the scope's own prefix: the default scope's rows
    // start with the bare word, so a new scope's rows never land in its count.
    [businessId, `${SCOPE_PREFIX[options.scope ?? 'default']}${CURATION_WORD}%`],
  );
  return Number(rows[0]?.n ?? '0');
}

export async function curateJob(
  db: BusinessDb,
  jobId: string,
  options: CurateJobOptions = {},
): Promise<CurationOutcome> {
  const businessId = db.businessId;
  const scope = options.scope ?? 'default';
  const prefix = SCOPE_PREFIX[scope];
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
    // A mail's triage job carries no plan by design; its brief comes from the
    // stored mail row, and the caller decides which categories qualify.
    if (scope === 'default') {
      const stored = await loadPlanBody(db, jobId);
      if (stored === null) return { ...idle, skipped: 'no_plan' };
      if (!jobQualifiesForCuration(stored.plan)) return { ...idle, skipped: 'not_qualified' };
      // A document delivery job (document production §5.7, C18) is never
      // curated — positive marker, its `document_deliveries` row (055). Its
      // mail.send step would otherwise qualify, and the delivery teaches
      // nothing the owner did not already approve byte for byte.
      const delivery = await db.query(
        'SELECT 1 FROM document_deliveries WHERE business_id = $1 AND job_id = $2',
        [businessId, jobId],
      );
      if ((delivery.rowCount ?? 0) > 0) return { ...idle, skipped: 'not_qualified' };
    }

    // Same switch discipline as DOCUMENT_INBOX: no key means the feature is
    // off, reported rather than silently identical to "nothing to remember".
    if (options.curator === undefined && (process.env['ANTHROPIC_API_KEY'] ?? '') === '') {
      return { ...idle, skipped: 'no_key' };
    }
    const runsPerDay =
      options.runsPerDay ??
      capFor(await loadRuntimeSettings(db), SCOPE_CAP[scope]);
    if ((await curationRunsToday(db, { scope })) >= runsPerDay) {
      return { ...idle, skipped: 'over_cap' };
    }

    // Distinct from `no_plan` above: a plan IS bound, but a brief could not
    // be built from it (see `buildCurationBrief`'s own null cases). Same
    // shape, different cause — collapsing them was an honesty-of-reporting
    // gap fix round 1 flagged (minor 7).
    const brief = scope === 'external' ? await buildExternalBrief(db, jobId) : await buildCurationBrief(db, jobId);
    if (brief === null) return { ...idle, skipped: 'no_brief' };

    const curator = options.curator ?? curateWithModel;
    const result = await curator(brief);
    const sifted = siftCandidates(result, brief.touched);
    rejected = sifted.rejected.length;

    for (const candidate of sifted.accepted) {
      // Mail and external scopes are chunk-only and never retire: the From
      // header is not authenticated, and an external system's data is written
      // by whoever runs it (a web form, a CRM record a stranger filled), so
      // neither may supersede a fact the assistant already holds. A chunk has
      // no uniqueness, so nothing is retired; the claim is kept as a labelled claim.
      const resolved =
        scope === 'default' ? await resolveConflict(db, candidate, jobId) : asChunk(candidate, CHUNK_NOTE[scope]);
      await writeMemory(
        db,
        {
          jobId,
          kind: resolved.kind,
          subjectKey: candidate.subjectKey,
          ...(resolved.kind === 'preference' ? { attribute: candidate.attribute ?? null } : {}),
          body: resolved.body,
          sourceRef: candidate.sourceRef,
        },
      );
      written += 1;
    }

    await appendAudit(
      db,
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
        reason: `${prefix}אצירה · ${written} עובדות נשמרו · ${rejected} נדחו`,
      }
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
    await recordCurationFailure(db, jobId, written, rejected, err, prefix);
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
  db: BusinessDb,
  jobId: string,
  written: number,
  rejected: number,
  err: unknown,
  prefix: string,
): Promise<void> {
  const errorKind = err instanceof Error ? err.constructor.name : 'unknown';
  try {
    await appendAudit(
      db,
      {
        actor: 'orchestrator',
        kind: 'curation',
        charterVersion: 'n/a',
        provenance: 'boss',
        inputHash: canonicalHash({ jobId, written, rejected, failed: true, errorKind }),
        artifacts: [],
        costMinor: null,
        tokens: null,
        reason: `${prefix}אצירה נכשלה · ${written} עובדות נשמרו לפני הכשל · ${rejected} נדחו · שגיאה: ${errorKind}`,
      }
    );
  } catch {
    // Swallowed on purpose — see the docblock above.
  }
}

function asChunk(candidate: CurationCandidate, note: string): { kind: 'chunk'; body: Record<string, unknown> } {
  if (candidate.kind === 'chunk') return { kind: 'chunk', body: candidate.body };
  return {
    kind: 'chunk',
    body: {
      claim: candidate.body,
      about: candidate.attribute ?? candidate.subjectKey,
      note,
    },
  };
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
  db: BusinessDb,
  candidate: CurationCandidate,
  jobId: string,
): Promise<{ kind: 'entity' | 'preference' | 'chunk'; body: Record<string, unknown> }> {
  const businessId = db.businessId;
  if (candidate.kind === 'chunk') return { kind: 'chunk', body: candidate.body };

  const { rows: jobRows } = await db.query<{ provenance: string }>(
    'SELECT provenance FROM jobs WHERE job_id = $1 AND business_id = $2',
    [jobId, businessId],
  );
  const incoming = jobRows[0]?.provenance;

  const attribute = candidate.kind === 'preference' ? (candidate.attribute ?? null) : null;
  const { rows: liveRows } = await db.query<{ provenance: string }>(
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
