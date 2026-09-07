/**
 * Shared shapes for the document intake pipeline
 * (docs/superpowers/specs/2026-08-28-document-intake-design.md §3, §4).
 *
 * Nothing in this file forces an extractor to declare which of the three
 * `content` shapes it produced — `DocumentArtifact.content` stays `unknown`
 * at the storage boundary, because the store does not care which shape it
 * holds. What lives here is the contract the three future extractors
 * (Excel, Word, CSV) and every later reader of `content` compile against, so
 * they cannot quietly drift apart from one another.
 */

/** Who brought a document in. */
export type DocumentSource = 'manual' | 'mail' | 'api';

/**
 * `pending` — stored, not yet parsed. `extracted` — parsed; its artefacts are
 * in `document_artifacts`. `rejected` — parsing refused it; `reason` says why
 * and the original bytes are still on disk (§8).
 */
export type DocumentStatus = 'pending' | 'extracted' | 'rejected';

/** What a `document_artifacts` row's `content` column holds the shape of. */
export type ArtifactKind = 'text' | 'table' | 'outline';

export type CellType = 'string' | 'number' | 'date' | 'bool' | 'empty';

/** One spreadsheet or table cell: its value, and what kind of value it is. */
export interface Cell {
  v: string | number | boolean | null;
  t: CellType;
}

/** The `content` of a `table` artefact. */
export interface TableContent {
  rows: Cell[][];
}

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] };

/** The `content` of a `text` artefact. */
export interface TextContent {
  blocks: Block[];
}

export interface OutlinePart {
  name: string | null;
  kind: ArtifactKind;
  rowCount?: number;
  headers?: string[];
  numericRanges?: Record<string, { min: number; max: number }>;
  dateRange?: { from: string; to: string };
}

/** The `content` of an `outline` artefact. */
export interface OutlineContent {
  parts: OutlinePart[];
  flags: string[];
}

/** A document, as stored — not its extracted parts. See `DocumentArtifact`. */
export interface DocumentRecord {
  documentId: string;
  businessId: string;
  source: DocumentSource;
  originalName: string;
  mediaType: string;
  sha256: string;
  byteSize: number;
  storedPath: string;
  status: DocumentStatus;
  reason: string | null;
  readAttempts: number;
  readError: string | null;
}

/**
 * One extracted part of a document — a sheet, a section, the document's own
 * outline. Scoped to a single document by the caller (`loadArtifacts(documentId, …)`),
 * so it carries no `documentId`/`businessId` of its own.
 */
export interface DocumentArtifact {
  ordinal: number;
  kind: ArtifactKind;
  partName: string | null;
  content: unknown;
  flags: string[];
}
