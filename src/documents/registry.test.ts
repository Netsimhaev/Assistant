import { describe, expect, it } from 'vitest';
import { CSV, DOCX, JSON as JSON_TYPE, MARKDOWN, TEXT, XLSX } from './media-type.js';
import { SUPPORTED, extractorFor } from './registry.js';

describe('the extractor registry', () => {
  it('has an extractor for every supported type, and no orphan extractors', () => {
    for (const mediaType of Object.keys(SUPPORTED)) {
      expect(extractorFor(mediaType), mediaType).not.toBeNull();
    }
    const used = new Set(Object.values(SUPPORTED));
    expect([...used].sort()).toEqual(['csv', 'docx', 'passthrough', 'xlsx']);
  });

  it('returns null for a type nobody named', () => {
    expect(extractorFor('application/octet-stream')).toBeNull();
  });

  it('does not answer for names inherited from Object.prototype', () => {
    expect(extractorFor('constructor')).toBeNull();
    expect(extractorFor('toString')).toBeNull();
    expect(extractorFor('__proto__')).toBeNull();
    expect(extractorFor('hasOwnProperty')).toBeNull();
  });

  it('maps each named media type to the expected extractor', () => {
    expect(extractorFor(XLSX)).toBe('xlsx');
    expect(extractorFor(DOCX)).toBe('docx');
    expect(extractorFor(CSV)).toBe('csv');
    expect(extractorFor(TEXT)).toBe('passthrough');
    expect(extractorFor(MARKDOWN)).toBe('passthrough');
    expect(extractorFor(JSON_TYPE)).toBe('passthrough');
  });
});
