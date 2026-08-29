/**
 * `readDocument` — artefacts in, a stored reading out (spec §6).
 *
 * The order these steps run in *is* the design, the same way it is in
 * `ingestDocument`:
 *
 *   loadArtifacts → (no artefacts? return) → markContentIngested →
 *   renderReadingBrief → hash → cache lookup → runKnowReader → saveReading
 *
 * **`markContentIngested` fires before anything can hand this job the
 * document's conclusions.** The flag is monotonic and exists so a job that
 * consumed outside content can never be granted the first-contact exemption; a
 * crash between the read and the write would otherwise leave a job that read
 * and does not remember it. Early is the safe direction — migration 011
 * carries the full argument. **And it fails closed:** a zero-row match means
 * the job id does not resolve, and the read does not run — the same decision
 * `src/sdk/gate-hook.ts` makes for the same reason.
 *
 * **A cache hit sets the flag too, and the earlier reasoning here was wrong.**
 * This docblock used to argue that a hit performs no read, so marking the job
 * would tighten a control on the strength of something that did not happen.
 * That conflated *did we call the model* with *did this job consume outside
 * content*. On the cache path the caller receives the whole `Reading` —
 * summary, findings, and intents naming counterparties, every one of them
 * derived from the document — exactly as it does on the fresh path. The flag
 * records what the job consumed, not what it paid for, so the lookup now sits
 * after the mark rather than in front of it. Otherwise job A reads a hostile
 * document, job B hits the cache, receives its intents, and keeps its
 * first-contact exemption.
 *
 * **The mark comes after the `no_artifacts` return, not before it.** A
 * document that yielded nothing hands the job nothing, and marking there would
 * restrict a job on the strength of an empty extraction — that is the case the
 * old argument was actually reaching for.
 *
 * **Nothing here throws for a bad response.** An unparseable answer is stored
 * as `unreadable` and returned, exactly as `ingestDocument` records a rejected
 * document. A genuine fault — the database unreachable, no API key — still
 * propagates, because that is not a property of the document.
 */

import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { Reading } from '../domain/reading.js';
import type { TrustLevel } from '../domain/trust.js';
import { markContentIngested } from '../orchestrator/jobs.js';
import { runKnowReader, type ReadOutcome, type ReadRequest } from '../sdk/know-reader.js';
import { READING_PROMPT_VERSION } from '../sdk/reading-prompt.js';
import { renderReadingBrief } from './brief.js';
import { findReadingForBrief, saveReading, type ReadingRecord } from './reading-store.js';
import { loadArtifacts } from './store.js';

export interface ReadDocumentInput {
  documentId: string;
  bundle: PolicyBundle;
  /** Trust of the source. Stored on the reading and never raised by it. */
  provenance: TrustLevel;
  /**
   * The job this read belongs to, or explicitly `null` when there is none.
   *
   * Required rather than optional, for the reason `GateHookBinding.jobId`
   * records: an omitted id and a genuinely job-less run must not be the same
   * value, or the content-ingested flag stops being set by accident.
   */
  jobId: string | null;
}

export interface ReadDocumentOptions {
  businessId?: string;
  db?: Queryable;
  documentRoot?: string;
  /**
   * The one step that costs money, injectable so the composition can be tested
   * without an API key. Not a mock of the SDK — every other step in this
   * function runs for real against the real database.
   */
  reader?: (request: ReadRequest) => Promise<ReadOutcome>;
}

export type ReadDocumentResult =
  | { status: 'read'; reading: Reading; record: ReadingRecord; cached: boolean }
  | { status: 'unreadable'; reason: string; record: ReadingRecord; cached: boolean }
  | { status: 'no_artifacts' };

function hashBrief(brief: string): string {
  return createHash('sha256').update(brief, 'utf8').digest('hex');
}

/** The model this reader runs on, recorded so a reading can be attributed. */
const READER_MODEL = 'haiku';

export async function readDocument(
  input: ReadDocumentInput,
  options: ReadDocumentOptions = {},
): Promise<ReadDocumentResult> {
  const businessId = options.businessId ?? config.businessId;
  const documentRoot = options.documentRoot ?? config.documentRoot;
  const reader = options.reader ?? runKnowReader;

  const artifacts = await loadArtifacts(input.documentId, {
    businessId,
    ...(options.db !== undefined ? { db: options.db } : {}),
  });
  if (artifacts.length === 0) {
    // Not a failed reading — there was nothing to read. Storing an
    // `unreadable` row here would blame the reader for the extractor's
    // silence.
    return { status: 'no_artifacts' };
  }

  if (input.jobId !== null) {
    // Before anything that could hand this job the document's conclusions —
    // which is the cache lookup, not just the model call. See this module's
    // header.
    const matched = await markContentIngested(input.jobId, {
      businessId,
      ...(options.db !== undefined ? { db: options.db } : {}),
    });
    // Fail closed on a zero-row match, for the reason `src/sdk/gate-hook.ts`
    // records at its own call site: `jobId` and `businessId` arrive here as
    // two independent caller-supplied fields, not read off a job row already
    // loaded, so a stale id, a typo, or a job belonging to another business
    // all produce a match of nothing that is indistinguishable from success.
    // Reading anyway would deliver the document's conclusions to a job whose
    // flag stayed false, and that job would later qualify for the
    // first-contact exemption on a chain that consumed outside content.
    //
    // This throws rather than returning a status. A job id that does not
    // resolve is not a property of the document — it is the same class as an
    // unreachable database, which spec §9 also says propagates.
    if (matched === 0) {
      throw new Error(
        `readDocument: content ingestion was not recorded for job ${input.jobId} — the read was not run`,
      );
    }
  }

  const brief = renderReadingBrief(artifacts);
  const briefHash = hashBrief(brief);

  const cached = await findReadingForBrief(
    input.documentId,
    briefHash,
    READING_PROMPT_VERSION,
    { businessId, ...(options.db !== undefined ? { db: options.db } : {}) },
  );
  if (cached !== null) return fromRecord(cached, true);

  const outcome = await reader({
    bundle: input.bundle,
    artifacts,
    provenance: input.provenance,
    businessId,
    jobId: input.jobId,
    documentRoot,
  });

  const { record } = await saveReading(
    {
      readingId: `RDG-${ulid()}`,
      documentId: input.documentId,
      status: outcome.status,
      reason: outcome.status === 'unreadable' ? outcome.reason : null,
      content: outcome.status === 'read' ? outcome.reading : null,
      provenance: input.provenance,
      model: READER_MODEL,
      promptVersion: READING_PROMPT_VERSION,
      briefHash,
    },
    { businessId, ...(options.db !== undefined ? { db: options.db } : {}) },
  );

  return fromRecord(record, false);
}

/**
 * One record, read back as a result.
 *
 * A stored row is the single source of truth for both paths — a cache hit and
 * a fresh read return the same shape from the same place, so the two can never
 * disagree about what was concluded.
 */
function fromRecord(record: ReadingRecord, cached: boolean): ReadDocumentResult {
  if (record.status === 'read' && record.content !== null) {
    return { status: 'read', reading: record.content, record, cached };
  }
  return {
    status: 'unreadable',
    reason: record.reason ?? 'unreadable, with no reason recorded',
    record,
    cached,
  };
}
