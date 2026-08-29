import { describe, expect, it } from 'vitest';
import { BRIEF_TABLE_ROWS, BRIEF_TEXT_CHARS, renderReadingBrief } from './brief.js';
import type { Cell, DocumentArtifact } from './types.js';

function s(v: string): Cell { return { v, t: 'string' }; }
function n(v: number): Cell { return { v, t: 'number' }; }

function tableArtifact(rowCount: number, ordinal = 1): DocumentArtifact {
  const rows: Cell[][] = [[s('פריט'), s('מחיר')]];
  for (let i = 0; i < rowCount; i += 1) rows.push([s(`שורה ${i}`), n(i * 10)]);
  return { ordinal, kind: 'table', partName: 'מחירון', content: { rows }, flags: [] };
}

const OUTLINE: DocumentArtifact = {
  ordinal: 0,
  kind: 'outline',
  partName: null,
  content: {
    parts: [{ name: 'מחירון', kind: 'table', rowCount: 3, headers: ['פריט', 'מחיר'] }],
    flags: ['has_macros'],
  },
  flags: [],
};

const TEXT: DocumentArtifact = {
  ordinal: 1,
  kind: 'text',
  partName: 'תנאי תשלום',
  content: {
    blocks: [
      { kind: 'heading', level: 1, text: 'תנאי תשלום' },
      { kind: 'paragraph', text: 'שוטף פלוס שלושים.' },
      { kind: 'list', items: ['מע"מ בנפרד', 'הובלה כלולה'] },
    ],
  },
  flags: ['tracked_changes'],
};

describe('renderReadingBrief', () => {
  it('leads with the outline, so the cheapest certain facts come first', () => {
    const brief = renderReadingBrief([OUTLINE, TEXT]);
    expect(brief.indexOf('מחירון')).toBeLessThan(brief.indexOf('שוטף פלוס שלושים'));
  });

  it('labels every part with the ordinal a citation must use', () => {
    const brief = renderReadingBrief([OUTLINE, TEXT]);
    expect(brief).toContain('[חלק 0]');
    expect(brief).toContain('[חלק 1]');
  });

  it('carries the document-level and part-level flags through', () => {
    const brief = renderReadingBrief([OUTLINE, TEXT]);
    expect(brief).toContain('has_macros');
    expect(brief).toContain('tracked_changes');
  });

  it('renders text blocks with their structure intact', () => {
    const brief = renderReadingBrief([TEXT]);
    expect(brief).toContain('שוטף פלוס שלושים.');
    expect(brief).toContain('מע"מ בנפרד');
  });

  it('caps a long table and says out loud that it did', () => {
    const brief = renderReadingBrief([tableArtifact(500)]);
    expect(brief).toContain('שורה 0');
    expect(brief).not.toContain('שורה 400');
    expect(brief).toContain('קוצץ');
    expect(brief).toContain(String(BRIEF_TABLE_ROWS));
  });

  it('keeps the header row on a capped table, over and above the row cap', () => {
    const brief = renderReadingBrief([tableArtifact(500)]);
    expect(brief).toContain('פריט');
    expect(brief).toContain('מחיר');
  });

  it('caps a long text artefact and marks it', () => {
    const long = 'א'.repeat(BRIEF_TEXT_CHARS + 500);
    const artifact: DocumentArtifact = {
      ordinal: 0, kind: 'text', partName: null,
      content: { blocks: [{ kind: 'paragraph', text: long }] }, flags: [],
    };
    const brief = renderReadingBrief([artifact]);
    expect(brief).toContain('קוצץ');
    expect(brief.length).toBeLessThan(long.length);
  });

  it('drops table rows before it drops the outline', () => {
    // Ten fat tables together exceed the total cap; the outline must survive.
    const fat = Array.from({ length: 10 }, (_, i) => tableArtifact(500, i + 1));
    const brief = renderReadingBrief([OUTLINE, ...fat]);
    expect(brief).toContain('מחירון');
    expect(brief).toContain('has_macros');
  });

  it('is deterministic — the same artefacts render byte-identically', () => {
    expect(renderReadingBrief([OUTLINE, TEXT])).toBe(renderReadingBrief([OUTLINE, TEXT]));
  });

  it('produces a brief for an empty artefact list rather than an empty string', () => {
    // An empty document is a fact to state, not a prompt with nothing in it.
    expect(renderReadingBrief([]).trim()).not.toBe('');
  });
});
