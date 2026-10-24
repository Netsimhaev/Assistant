/**
 * The extractor registry (docs/superpowers/specs/2026-08-28-document-intake-design.md §3.3).
 *
 * A positive map from media type to extractor. A type absent from `SUPPORTED`
 * is rejected — the same rule already enforced at the SDK tool boundary
 * (`src/sdk/tool-names.ts`): what has no name here does not get parsed.
 */

import { CSV, DOCX, JSON as JSON_TYPE, MARKDOWN, PDF, TEXT, XLSX } from './media-type.js';

export type ExtractorId = 'xlsx' | 'docx' | 'csv' | 'passthrough' | 'pdf';

export const SUPPORTED: Record<string, ExtractorId> = {
  [TEXT]: 'passthrough',
  [MARKDOWN]: 'passthrough',
  [JSON_TYPE]: 'passthrough',
  [CSV]: 'csv',
  [XLSX]: 'xlsx',
  [DOCX]: 'docx',
  [PDF]: 'pdf',
};

/**
 * `null` means unsupported. `Object.hasOwn`, not a bare index — `SUPPORTED`
 * is an object literal, so `SUPPORTED['constructor']` and a dozen other
 * inherited names resolve to something that is not `undefined`. A lookup
 * whose contract is "absent means unsupported" must not answer for them.
 */
export function extractorFor(mediaType: string): ExtractorId | null {
  return Object.hasOwn(SUPPORTED, mediaType) ? (SUPPORTED[mediaType] ?? null) : null;
}
