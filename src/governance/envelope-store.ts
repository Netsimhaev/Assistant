/**
 * The record of one agent asking another for help, and of what came back.
 *
 * `agent_envelopes` is the durable half of delegation; `delegation.ts` keeps
 * the five guards pure and takes the rows they need as arguments rather than
 * querying for them, so every write and read against those rows lives here.
 */
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import type { Queryable } from '../db/pool.js';
import type { AgentEnvelope } from '../domain/envelope.js';
import type { EnvelopeConstraints, EnvelopeKind } from '../domain/envelope.js';
import { contextRefsHash } from './delegation.js';

interface EnvelopeRow {
  envelope_id: string;
  correlation_id: string;
  causal_chain: string[];
  from_agent: string;
  to_agent: string;
  kind: string;
  intent: string;
  payload: unknown;
  context_refs: unknown;
  constraints: unknown;
  hops: number;
  idempotency_key: string;
  created_at: Date;
  child_job_id: string | null;
}

/**
 * `v` is a literal (always 1) and carries no column of its own — storing a
 * constant is nothing a round trip could ever disagree about. `createdAt` is
 * the one exception: the envelope supplies it, and it is written as-is rather
 * than left to the column's `DEFAULT now()`, because the round trip must hand
 * back the exact instant the caller minted, not the instant it was persisted.
 */
function toEnvelope(row: EnvelopeRow): AgentEnvelope {
  return {
    v: 1,
    id: row.envelope_id,
    correlationId: row.correlation_id,
    causalChain: row.causal_chain,
    from: row.from_agent as AgentEnvelope['from'],
    to: row.to_agent as AgentEnvelope['to'],
    kind: row.kind as EnvelopeKind,
    intent: row.intent,
    payload: row.payload,
    contextRefs: row.context_refs as AgentEnvelope['contextRefs'],
    constraints: row.constraints as EnvelopeConstraints,
    hops: row.hops,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
  };
}

export type WriteEnvelopeResult =
  | { status: 'stored'; envelope: AgentEnvelope; childJobId: string | null }
  | { status: 'duplicate'; envelope: AgentEnvelope; childJobId: string | null };

/**
 * Store one envelope, keyed on `(businessId, idempotencyKey)`.
 *
 * **Insert-then-read, never read-then-insert** — the same shape
 * `bindPlanToJob` (`orchestrator/plan-store.ts`) holds and for the same
 * reason: two callers that both check "does this key exist yet?" before
 * writing can both see "no" and both proceed, and a delegation sent twice is
 * a message the receiving agent acts on twice. The `INSERT ... ON CONFLICT
 * DO NOTHING RETURNING *` is the only statement that decides who stored the
 * row; a row that comes back empty means someone else's write already won,
 * and the follow-up `SELECT` only fetches what is already there to hand back
 * to the caller — it never has to raced against anything, because by the
 * time `ON CONFLICT` fires, the winning row is already committed.
 */
export async function writeEnvelope(
  envelope: AgentEnvelope,
  options: { parentJobId: string; childJobId?: string | null; businessId?: string; db?: Queryable },
): Promise<WriteEnvelopeResult> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const childJobId = options.childJobId ?? null;

  const inserted = await db.query<EnvelopeRow>(
    `INSERT INTO agent_envelopes (
       business_id, envelope_id, correlation_id, causal_chain, from_agent, to_agent,
       kind, intent, payload, context_refs, context_refs_hash, constraints, hops,
       idempotency_key, parent_job_id, child_job_id, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (business_id, idempotency_key) DO NOTHING
     RETURNING envelope_id, correlation_id, causal_chain, from_agent, to_agent, kind,
               intent, payload, context_refs, constraints, hops, idempotency_key, created_at,
               child_job_id`,
    [
      businessId,
      envelope.id,
      envelope.correlationId,
      envelope.causalChain,
      envelope.from,
      envelope.to,
      envelope.kind,
      envelope.intent,
      JSON.stringify(envelope.payload ?? null),
      JSON.stringify(envelope.contextRefs),
      contextRefsHash(envelope.contextRefs),
      JSON.stringify(envelope.constraints),
      envelope.hops,
      envelope.idempotencyKey,
      options.parentJobId,
      childJobId,
      envelope.createdAt,
    ],
  );

  const storedRow = inserted.rows[0];
  if (storedRow) {
    return { status: 'stored', envelope: toEnvelope(storedRow), childJobId: storedRow.child_job_id };
  }

  const { rows } = await db.query<EnvelopeRow>(
    `SELECT envelope_id, correlation_id, causal_chain, from_agent, to_agent, kind,
            intent, payload, context_refs, constraints, hops, idempotency_key, created_at,
            child_job_id
       FROM agent_envelopes
      WHERE business_id = $1 AND idempotency_key = $2`,
    [businessId, envelope.idempotencyKey],
  );
  const existing = rows[0];
  if (!existing) {
    // The row existed a statement ago (that is what made INSERT conflict)
    // and does not now — only a concurrent delete explains it. Louder than
    // pretending we stored one.
    throw new Error(
      `envelope with idempotency key ${envelope.idempotencyKey} vanished between insert and read`,
    );
  }
  // `childJobId` on the duplicate branch is what lets a caller that sees
  // `duplicate` tell "the earlier attempt finished opening its child" from
  // "it crashed between writing this row and attaching one" — the repair a
  // retry can make is `attachChildJob`, and it needs to know whether that
  // repair is even needed.
  return { status: 'duplicate', envelope: toEnvelope(existing), childJobId: existing.child_job_id };
}

export interface StoredEnvelope {
  envelope: AgentEnvelope;
  /** `null` when this envelope has not (yet) had a child attached to it. */
  childJobId: string | null;
}

/**
 * One envelope by id, together with the `child_job_id` column — or null if
 * this business has never stored one under it.
 *
 * This is the read `requestHelp` uses to verify a caller-supplied
 * `parentEnvelope` against the database rather than trusting the object's own
 * fields: `envelope.id` says which row to load, and everything else this
 * function returns — `hops`, `correlationId`, `causalChain`, `constraints`,
 * and now `childJobId` — comes from the row, never from the caller's claim.
 * A caller holding a legitimate envelope id whose `child_job_id` really is
 * its own job could otherwise still supply `hops: 0` to slip `hopGuard`, a
 * different `correlationId` to escape both anti-ping-pong guards' scope, or a
 * loosened `constraints` to widen the child's ceiling — the exact laundering
 * `grantAuthorization` already refuses for a job's claimed provenance, and
 * `GateContext.standing` for a claimed authorisation.
 */
export async function loadEnvelopeWithChild(
  envelopeId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<StoredEnvelope | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<EnvelopeRow>(
    `SELECT envelope_id, correlation_id, causal_chain, from_agent, to_agent, kind,
            intent, payload, context_refs, constraints, hops, idempotency_key, created_at,
            child_job_id
       FROM agent_envelopes
      WHERE business_id = $1 AND envelope_id = $2`,
    [businessId, envelopeId],
  );
  const row = rows[0];
  return row ? { envelope: toEnvelope(row), childJobId: row.child_job_id } : null;
}

/**
 * One envelope by its idempotency key, together with the `child_job_id`
 * column — or `null` if this exact request was never answered before.
 *
 * **This is guard 3, checked BEFORE every other guard `requestHelp` owns —
 * hop, daily cap, no-new-information, oscillation — and the ordering is the
 * fix, not a detail of it.** A `parked` step (`execute.ts`'s `StepOutcome`)
 * writes no completion row, so a resumed run's retry of `agent.request_help`
 * calls `requestHelp` again with a byte-identical request, which means the
 * SAME idempotency key the first, successful call already wrote. Guard 4
 * alone would refuse that as `no_new_information` — true, but the wrong
 * answer, and `requestHelp`'s caller (`local-tools.ts`'s `agent.request_help`
 * handler) cannot tell that refusal apart from a genuine one, so it read the
 * parent's phase as still `execute`, threw non-retryably, and `executeStep`
 * failed the parent job outright. Checking guard 3 first only got half of
 * this fixed: `dailyCapGuard` reads a SHARED, TIME-VARYING counter
 * (`delegationsToday()`), so an installation that reached its cap between
 * the original call and the resumed one still failed every parked parent
 * that day — a repeat of an already-answered request must not depend on
 * ANY guard's answer, because the question it is answering ("did this
 * already happen") has nothing to do with today's counters.
 *
 * The key includes `parentJobId`, not just
 * `(correlationId, from, to, intent, contextRefsHash, payload)` — two
 * DIFFERENT parent jobs in one correlation can legitimately issue the
 * byte-identical request, and without `parentJobId` the second one would
 * silently resolve to the first one's envelope and child rather than being
 * refused or opening its own. That also restores the division between guard
 * 3 and guard 4: guard 3 now answers "is THIS JOB retrying its own prior
 * request", and guard 4 (unscoped by `parentJobId`) answers "has ANYONE in
 * this tree already asked this".
 */
export async function loadEnvelopeByIdempotencyKey(
  idempotencyKey: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<StoredEnvelope | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<EnvelopeRow>(
    `SELECT envelope_id, correlation_id, causal_chain, from_agent, to_agent, kind,
            intent, payload, context_refs, constraints, hops, idempotency_key, created_at,
            child_job_id
       FROM agent_envelopes
      WHERE business_id = $1 AND idempotency_key = $2`,
    [businessId, idempotencyKey],
  );
  const row = rows[0];
  return row ? { envelope: toEnvelope(row), childJobId: row.child_job_id } : null;
}

/** One envelope by id, or null if this business has never stored one under it. */
export async function loadEnvelope(
  envelopeId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AgentEnvelope | null> {
  const stored = await loadEnvelopeWithChild(envelopeId, options);
  return stored ? stored.envelope : null;
}

export interface EnvelopeQuadruple {
  from: string;
  to: string;
  intent: string;
  contextRefsHash: string;
}

interface QuadrupleRow {
  from_agent: string;
  to_agent: string;
  intent: string;
  context_refs_hash: string;
}

/**
 * Every quadruple exchanged inside one correlation — the argument
 * `noNewInformationGuard` (`delegation.ts`) needs to decide guard 4.
 *
 * Scoped to `correlationId`, not to the whole business: without the scope, a
 * legitimate request in one job would be refused because the same
 * `(from, to, intent, contextRefsHash)` happened to appear in an unrelated
 * job's tree.
 */
export async function priorQuadruples(
  correlationId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<EnvelopeQuadruple[]> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<QuadrupleRow>(
    // `kind = 'help_request'` — `resumeDelegatedJobs` (Task 7) is now a
    // writer of `result` rows in the OPPOSITE direction (`from`/`to`
    // swapped), and without this filter every answer counts as a fresh
    // request from the child back to the parent, corrupting guard 4 for a
    // pair that never actually asked anything twice.
    `SELECT from_agent, to_agent, intent, context_refs_hash
       FROM agent_envelopes
      WHERE business_id = $1 AND correlation_id = $2 AND kind = 'help_request'`,
    [businessId, correlationId],
  );
  return rows.map((row) => ({
    from: row.from_agent,
    to: row.to_agent,
    intent: row.intent,
    contextRefsHash: row.context_refs_hash,
  }));
}

/**
 * How many times this exact pair has exchanged on this exact intent, inside
 * one correlation — the argument `oscillationGuard` (`delegation.ts`) needs
 * to decide guard 5.
 */
export async function countPairExchanges(
  correlationId: string,
  from: string,
  to: string,
  intent: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<number> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ n: string }>(
    // `kind = 'help_request'`, for the same reason `priorQuadruples` filters
    // it above: a `result` envelope going the other way must not inflate the
    // exchange count between this pair.
    `SELECT count(*)::text AS n
       FROM agent_envelopes
      WHERE business_id = $1 AND correlation_id = $2 AND from_agent = $3
        AND to_agent = $4 AND intent = $5 AND kind = 'help_request'`,
    [businessId, correlationId, from, to, intent],
  );
  return Number(rows[0]?.n ?? '0');
}

/**
 * The daily ceiling counts AUDIT rows, not `agent_envelopes` rows — the same
 * reasoning `curationRunsToday` (`memory/curate.ts`) already carries. A
 * delegation that was billed (an SDK call to the receiving agent) and then
 * failed before an envelope was ever written down still cost money, and a
 * ceiling meant to fence billed calls must count it. Counting
 * `agent_envelopes` rows would also under-count in the crash window between
 * "the call went out" and "the envelope was persisted".
 *
 * `AuditKind` does not carry a `'delegation'` member yet — a later task adds
 * it and starts writing these rows in production. This reader does not wait
 * for that: it counts whatever `audit_log.kind = 'delegation'` rows exist
 * today, by string, exactly as `curationRunsToday` counts `'curation'`.
 */
export async function delegationsToday(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<number> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM audit_log
      WHERE business_id = $1 AND kind = 'delegation' AND at >= date_trunc('day', now())`,
    [businessId],
  );
  return Number(rows[0]?.n ?? '0');
}

/**
 * The envelope that opened this job as a delegation's child — `null` for an
 * ordinary root job nothing ever delegated into.
 *
 * Backed by `agent_envelopes_child_idx` (`business_id, child_job_id`),
 * migration 028's own comment on which names `resumeDelegatedJobs` as the
 * reader. Task 7 gives it two readers instead: `runDueJobs`, which — before
 * running a job's step — asks whether some envelope governs it at all, so
 * `constraints.autonomyCeiling` can be folded into `GateContext.autonomyCeiling`
 * instead of a hard cap the envelope carries being silently dropped on the
 * floor; and `agent.request_help`'s own handler (`orchestrator/local-tools.ts`),
 * which asks the same question about the CURRENT job before it opens a
 * second-hop delegation, so a child that itself delegates inherits from its
 * real ancestor rather than being treated as a fresh root.
 * `resumeDelegatedJobs` itself does not need this: it starts from the PARENT
 * side, via `jobs.awaiting_envelope_id`, and reaches the envelope by its
 * primary key instead.
 */
export async function loadEnvelopeForChildJob(
  childJobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AgentEnvelope | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<EnvelopeRow>(
    `SELECT envelope_id, correlation_id, causal_chain, from_agent, to_agent, kind,
            intent, payload, context_refs, constraints, hops, idempotency_key, created_at,
            child_job_id
       FROM agent_envelopes
      WHERE business_id = $1 AND child_job_id = $2`,
    [businessId, childJobId],
  );
  const row = rows[0];
  return row ? toEnvelope(row) : null;
}

/**
 * The `result` envelope answering a delegation, found by its correlation and
 * the child job it names — or `null` if `resumeDelegatedJobs` has not yet
 * decided this delegation's outcome.
 *
 * `resumeDelegatedJobs` (`orchestrator/resume-delegated.ts`) writes exactly
 * this shape: `kind = 'result'`, the same `correlationId` as the request it
 * answers, `contextRefs: [{kind:'job', jobId: <childJobId>}]`, for a close, a
 * failure, or a timeout alike. This is what lets `agent.request_help`'s own
 * handler (`orchestrator/local-tools.ts`) complete a resumed step UNIFORMLY
 * across all three outcomes by reading the answer, rather than re-deriving
 * one from the child's raw phase — which broke specifically for a timeout: a
 * child woken past its deadline while still running has no terminal phase at
 * all, so a phase-based check finds nothing to complete the step with and the
 * parent polls forever.
 *
 * `correlation_id = $2` is a real predicate, not decoration: without it, this
 * query matches on `kind = 'result'` plus a job contextRef alone, and the
 * only thing standing between that and a cross-tree collision was a comment
 * asserting `resumeDelegatedJobs` is the only producer and writes one result
 * per child — an invariant this codebase has already paid to learn belongs in
 * the predicate, not in prose (`kind = 'help_request'` on `priorQuadruples`
 * and `countPairExchanges` is the same lesson, paid for twice already).
 *
 * `context_refs @> $3::jsonb` (containment), not equality: `contextRefs` is
 * an array, and the result envelope always carries this one ref as its only
 * element, but containment is what generalises correctly for the same reason
 * `contextRefsHash` sorts before hashing (`delegation.ts`) — this reads
 * whichever position holds it rather than assuming exactly one.
 * `ORDER BY created_at DESC LIMIT 1` picks the newest if more than one ever
 * exists.
 */
export async function loadResultForChildJob(
  childJobId: string,
  correlationId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AgentEnvelope | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<EnvelopeRow>(
    `SELECT envelope_id, correlation_id, causal_chain, from_agent, to_agent, kind,
            intent, payload, context_refs, constraints, hops, idempotency_key, created_at,
            child_job_id
       FROM agent_envelopes
      WHERE business_id = $1 AND correlation_id = $2 AND kind = 'result' AND context_refs @> $3::jsonb
      ORDER BY created_at DESC
      LIMIT 1`,
    [businessId, correlationId, JSON.stringify([{ kind: 'job', jobId: childJobId }])],
  );
  const row = rows[0];
  return row ? toEnvelope(row) : null;
}

/**
 * Fill in the child job a `help_request` envelope spawned, once the
 * orchestrator has actually created it. This is the column Task 7's
 * `resumeDelegatedJobs` will read (via `agent_envelopes_child_idx`) to find
 * the envelope waiting on a child job that just finished — not built yet, so
 * this states what the column is for, not what already reads it.
 */
export async function attachChildJob(
  envelopeId: string,
  childJobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  await db.query(
    `UPDATE agent_envelopes SET child_job_id = $3 WHERE business_id = $1 AND envelope_id = $2`,
    [businessId, envelopeId, childJobId],
  );
}
