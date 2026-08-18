import { config } from '../config.js';
import type { AuditEntry, AuditEntryInput } from '../domain/audit.js';
import { GENESIS_HASH } from '../domain/audit.js';
import {
  acquireAdvisoryLock,
  getPool,
  withTransaction,
  type Queryable,
} from '../db/pool.js';
import { chainHash } from '../util/canonical.js';

/**
 * The payload that actually gets hashed. Deliberately excludes `seq` (assigned
 * by the sequence, not known before insert) and `at` (assigned here so the
 * clock cannot be supplied by a caller).
 */
interface ChainedPayload {
  at: string;
  jobId: string | null;
  envelopeId: string | null;
  actor: string;
  onBehalfOf: string | null;
  kind: string;
  actionClass: string | null;
  charterVersion: string;
  provenance: string;
  risk: unknown;
  inputHash: string;
  outputHash: string | null;
  artifacts: unknown;
  costMinor: number | null;
  tokens: unknown;
  reason: string;
}

export interface AppendedEntry {
  seq: bigint;
  at: string;
  hash: string;
  prevHash: string;
}

/**
 * Append one entry to the hash-chained audit log.
 *
 * Serialised per business with an advisory lock: two concurrent appends that
 * both read the same tail would produce two entries claiming the same
 * predecessor, which silently forks the chain. The lock is held for the
 * transaction, so it releases on commit or rollback either way.
 */
export async function appendAudit(
  input: AuditEntryInput,
  options: { businessId?: string; tx?: Queryable } = {},
): Promise<AppendedEntry> {
  const businessId = options.businessId ?? config.businessId;

  const run = async (tx: Queryable): Promise<AppendedEntry> => {
    await acquireAdvisoryLock(tx, `audit:${businessId}`);

    const { rows } = await tx.query<{ hash: string }>(
      'SELECT hash FROM audit_log WHERE business_id = $1 ORDER BY seq DESC LIMIT 1',
      [businessId],
    );
    const prevHash = rows[0]?.hash ?? GENESIS_HASH;

    const at = new Date().toISOString();
    const payload: ChainedPayload = {
      at,
      jobId: input.jobId ?? null,
      envelopeId: input.envelopeId ?? null,
      actor: input.actor,
      onBehalfOf: input.onBehalfOf ?? null,
      kind: input.kind,
      actionClass: input.actionClass ?? null,
      charterVersion: input.charterVersion,
      provenance: input.provenance,
      risk: input.risk ?? null,
      inputHash: input.inputHash,
      outputHash: input.outputHash ?? null,
      artifacts: input.artifacts ?? [],
      costMinor: input.costMinor ?? null,
      tokens: input.tokens ?? null,
      reason: input.reason,
    };

    const hash = chainHash(prevHash, payload);

    const inserted = await tx.query<{ seq: bigint }>(
      `INSERT INTO audit_log (
         business_id, at, job_id, envelope_id, actor, on_behalf_of, kind,
         action_class, charter_version, provenance, risk, input_hash,
         output_hash, artifacts, cost_minor, tokens, reason, prev_hash, hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING seq`,
      [
        businessId,
        payload.at,
        payload.jobId,
        payload.envelopeId,
        payload.actor,
        payload.onBehalfOf,
        payload.kind,
        payload.actionClass,
        payload.charterVersion,
        payload.provenance,
        payload.risk === null ? null : JSON.stringify(payload.risk),
        payload.inputHash,
        payload.outputHash,
        JSON.stringify(payload.artifacts),
        payload.costMinor,
        payload.tokens === null ? null : JSON.stringify(payload.tokens),
        payload.reason,
        prevHash,
        hash,
      ],
    );

    const seq = inserted.rows[0]?.seq;
    if (seq === undefined) {
      throw new Error('audit append returned no sequence number');
    }
    return { seq, at, hash, prevHash };
  };

  return options.tx ? run(options.tx) : withTransaction(run);
}

// ---------------------------------------------------------------------------

interface AuditRow {
  seq: bigint;
  at: Date;
  job_id: string | null;
  envelope_id: string | null;
  actor: string;
  on_behalf_of: string | null;
  kind: string;
  action_class: string | null;
  charter_version: string;
  provenance: string;
  risk: unknown;
  input_hash: string;
  output_hash: string | null;
  artifacts: unknown;
  cost_minor: string | number | null;
  tokens: unknown;
  reason: string;
  prev_hash: string;
  hash: string;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    seq: row.seq,
    at: row.at.toISOString(),
    jobId: row.job_id,
    envelopeId: row.envelope_id,
    actor: row.actor as AuditEntry['actor'],
    onBehalfOf: row.on_behalf_of,
    kind: row.kind as AuditEntry['kind'],
    actionClass: row.action_class as AuditEntry['actionClass'],
    charterVersion: row.charter_version,
    provenance: row.provenance as AuditEntry['provenance'],
    risk: (row.risk ?? null) as AuditEntry['risk'],
    inputHash: row.input_hash,
    outputHash: row.output_hash,
    artifacts: (row.artifacts ?? []) as AuditEntry['artifacts'],
    costMinor: row.cost_minor === null ? null : Number(row.cost_minor),
    tokens: (row.tokens ?? null) as AuditEntry['tokens'],
    reason: row.reason,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export interface AuditQuery {
  businessId?: string;
  jobId?: string;
  kind?: string;
  actionClass?: string;
  limit?: number;
}

/** Newest first. This is what the dashboard's plain-language view reads. */
export async function queryAudit(
  query: AuditQuery = {},
  db: Queryable = getPool(),
): Promise<AuditEntry[]> {
  const businessId = query.businessId ?? config.businessId;
  const conditions = ['business_id = $1'];
  const params: unknown[] = [businessId];

  if (query.jobId !== undefined) {
    params.push(query.jobId);
    conditions.push(`job_id = $${params.length}`);
  }
  if (query.kind !== undefined) {
    params.push(query.kind);
    conditions.push(`kind = $${params.length}`);
  }
  if (query.actionClass !== undefined) {
    params.push(query.actionClass);
    conditions.push(`action_class = $${params.length}`);
  }
  params.push(query.limit ?? 100);

  const { rows } = await db.query<AuditRow>(
    `SELECT * FROM audit_log
      WHERE ${conditions.join(' AND ')}
      ORDER BY seq DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(toEntry);
}

export type ChainVerification =
  | { intact: true; entries: number }
  | { intact: false; brokenAtSeq: bigint; reason: string };

/**
 * Walk the chain from genesis and verify every link.
 *
 * Two independent failures are detectable here: a mutated payload (the stored
 * hash no longer matches what the payload hashes to) and a removed entry (the
 * next entry's prevHash no longer matches its predecessor's hash). The
 * append-only trigger makes both hard; this makes both *provable*.
 */
export async function verifyChain(
  businessId: string = config.businessId,
  db: Queryable = getPool(),
): Promise<ChainVerification> {
  const { rows } = await db.query<AuditRow>(
    'SELECT * FROM audit_log WHERE business_id = $1 ORDER BY seq ASC',
    [businessId],
  );

  let expectedPrev = GENESIS_HASH;
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return {
        intact: false,
        brokenAtSeq: row.seq,
        reason:
          `entry ${row.seq} claims predecessor ${row.prev_hash.slice(0, 12)}… ` +
          `but the chain is at ${expectedPrev.slice(0, 12)}… — an entry was removed or reordered`,
      };
    }

    const entry = toEntry(row);
    const recomputed = chainHash(row.prev_hash, {
      at: entry.at,
      jobId: entry.jobId,
      envelopeId: entry.envelopeId,
      actor: entry.actor,
      onBehalfOf: entry.onBehalfOf,
      kind: entry.kind,
      actionClass: entry.actionClass,
      charterVersion: entry.charterVersion,
      provenance: entry.provenance,
      risk: entry.risk,
      inputHash: entry.inputHash,
      outputHash: entry.outputHash,
      artifacts: entry.artifacts,
      costMinor: entry.costMinor,
      tokens: entry.tokens,
      reason: entry.reason,
    } satisfies ChainedPayload);

    if (recomputed !== row.hash) {
      return {
        intact: false,
        brokenAtSeq: row.seq,
        reason: `entry ${row.seq} payload does not match its hash — it was altered after being written`,
      };
    }
    expectedPrev = row.hash;
  }

  return { intact: true, entries: rows.length };
}
