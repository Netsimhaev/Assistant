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
  | { status: 'stored'; envelope: AgentEnvelope }
  | { status: 'duplicate'; envelope: AgentEnvelope };

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
               intent, payload, context_refs, constraints, hops, idempotency_key, created_at`,
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
    return { status: 'stored', envelope: toEnvelope(storedRow) };
  }

  const { rows } = await db.query<EnvelopeRow>(
    `SELECT envelope_id, correlation_id, causal_chain, from_agent, to_agent, kind,
            intent, payload, context_refs, constraints, hops, idempotency_key, created_at
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
  return { status: 'duplicate', envelope: toEnvelope(existing) };
}

/** One envelope by id, or null if this business has never stored one under it. */
export async function loadEnvelope(
  envelopeId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AgentEnvelope | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<EnvelopeRow>(
    `SELECT envelope_id, correlation_id, causal_chain, from_agent, to_agent, kind,
            intent, payload, context_refs, constraints, hops, idempotency_key, created_at
       FROM agent_envelopes
      WHERE business_id = $1 AND envelope_id = $2`,
    [businessId, envelopeId],
  );
  const row = rows[0];
  return row ? toEnvelope(row) : null;
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
    `SELECT from_agent, to_agent, intent, context_refs_hash
       FROM agent_envelopes
      WHERE business_id = $1 AND correlation_id = $2`,
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
    `SELECT count(*)::text AS n
       FROM agent_envelopes
      WHERE business_id = $1 AND correlation_id = $2 AND from_agent = $3
        AND to_agent = $4 AND intent = $5`,
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
 * Fill in the child job a `help_request` envelope spawned, once the
 * orchestrator has actually created it. This is the column
 * `resumeDelegatedJobs` reads (via `agent_envelopes_child_idx`) to find the
 * envelope waiting on a child job that just finished.
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
