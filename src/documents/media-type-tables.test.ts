/**
 * A structural test, not a behavioural one — the same kind
 * `charter/capabilities.test.ts` locks for the policy tables (CLAUDE.md:
 * "the structural tests are a guardrail"). Three tables have to agree with
 * each other for the intake pipeline to work at all, and nothing before
 * this file made that mechanical:
 *
 *   - `media-type.ts`'s exported media-type constants
 *   - `registry.ts`'s `SUPPORTED` map (media type → `ExtractorId`)
 *   - `ingest.ts`'s `EXTENSION_BY_MEDIA_TYPE` (media type → stored extension)
 *   - `extract-child.ts`'s `KNOWN_EXTRACTORS` (every `ExtractorId` the child
 *     actually dispatches)
 *
 * A media type present in `media-type.ts` but missing from `SUPPORTED` or
 * `EXTENSION_BY_MEDIA_TYPE` is a type `sniffMediaType` can name that the
 * rest of the pipeline silently cannot carry all the way through. An
 * `ExtractorId` missing from `KNOWN_EXTRACTORS` is a value the registry can
 * hand back that the isolated child has no dispatch case for — it would
 * compile everywhere (both are typed against the same `ExtractorId` union)
 * and still crash at runtime the moment `extractorFor` returns it.
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_EXTRACTORS } from './extract-child.js';
import { EXTENSION_BY_MEDIA_TYPE } from './ingest.js';
import * as MediaType from './media-type.js';
import { SUPPORTED } from './registry.js';
import type { ExtractorId } from './registry.js';

/** Every media-type constant `media-type.ts` exports — filtered from the module's namespace import rather than hand-copied, so a new constant is picked up automatically instead of needing this file edited too. `sniffMediaType` is the one non-string (function) export and is excluded by the `typeof` check alone. */
const MEDIA_TYPE_CONSTANTS: readonly string[] = (Object.values(MediaType) as unknown[]).filter(
  (value): value is string => typeof value === 'string',
);

// A `Record<ExtractorId, true>` fails to type-check the moment `ExtractorId`
// gains a variant this object doesn't list — the same "must be updated by
// hand, and TypeScript enforces it" property `positive-controls.test.ts`
// relies on elsewhere in this codebase. This is the one place in this file
// that has to be hand-maintained; everything else is derived.
const ALL_EXTRACTOR_IDS: Record<ExtractorId, true> = {
  xlsx: true,
  docx: true,
  csv: true,
  passthrough: true,
};

describe('the three media-type tables stay in sync', () => {
  it('has at least one media-type constant to check (this test is not vacuously true)', () => {
    expect(MEDIA_TYPE_CONSTANTS.length).toBeGreaterThan(0);
  });

  it('every media-type constant has an entry in registry.ts\'s SUPPORTED', () => {
    for (const mediaType of MEDIA_TYPE_CONSTANTS) {
      expect(Object.hasOwn(SUPPORTED, mediaType), mediaType).toBe(true);
    }
  });

  it('every media-type constant has an entry in ingest.ts\'s EXTENSION_BY_MEDIA_TYPE', () => {
    for (const mediaType of MEDIA_TYPE_CONSTANTS) {
      expect(Object.hasOwn(EXTENSION_BY_MEDIA_TYPE, mediaType), mediaType).toBe(true);
    }
  });

  it('every ExtractorId has a dispatch case in extract-child.ts\'s KNOWN_EXTRACTORS', () => {
    for (const extractorId of Object.keys(ALL_EXTRACTOR_IDS) as ExtractorId[]) {
      expect(KNOWN_EXTRACTORS.includes(extractorId), extractorId).toBe(true);
    }
  });

  it('SUPPORTED names no ExtractorId that KNOWN_EXTRACTORS does not also know', () => {
    for (const extractorId of Object.values(SUPPORTED)) {
      expect(KNOWN_EXTRACTORS.includes(extractorId), extractorId).toBe(true);
    }
  });
});
