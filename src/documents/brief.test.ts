import { describe, expect, it } from 'vitest';
import { ungroundedNumbers } from '../governance/numeric-grounding.js';
import {
  BRIEF_TABLE_ROWS,
  BRIEF_TEXT_CHARS,
  BRIEF_TOTAL_CHARS,
  renderArtifactFull,
  renderReadingBrief,
} from './brief.js';
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
    const { brief } = renderReadingBrief([OUTLINE, TEXT]);
    expect(brief.indexOf('מחירון')).toBeLessThan(brief.indexOf('שוטף פלוס שלושים'));
  });

  it('labels every part with the ordinal a citation must use', () => {
    const { brief } = renderReadingBrief([OUTLINE, TEXT]);
    expect(brief).toContain('[חלק 0]');
    expect(brief).toContain('[חלק 1]');
  });

  it('carries the document-level and part-level flags through', () => {
    const { brief } = renderReadingBrief([OUTLINE, TEXT]);
    expect(brief).toContain('has_macros');
    expect(brief).toContain('tracked_changes');
  });

  it('renders text blocks with their structure intact', () => {
    const { brief } = renderReadingBrief([TEXT]);
    expect(brief).toContain('שוטף פלוס שלושים.');
    expect(brief).toContain('מע"מ בנפרד');
  });

  it('caps a long table and says out loud that it did', () => {
    const { brief } = renderReadingBrief([tableArtifact(500)]);
    expect(brief).toContain('שורה 0');
    expect(brief).not.toContain('שורה 400');
    expect(brief).toContain('קוצץ');
    expect(brief).toContain(String(BRIEF_TABLE_ROWS));
  });

  it('keeps the header row on a capped table, over and above the row cap', () => {
    const { brief } = renderReadingBrief([tableArtifact(500)]);
    expect(brief).toContain('פריט');
    expect(brief).toContain('מחיר');
  });

  it('caps a long text artefact and marks it', () => {
    const long = 'א'.repeat(BRIEF_TEXT_CHARS + 500);
    const artifact: DocumentArtifact = {
      ordinal: 0, kind: 'text', partName: null,
      content: { blocks: [{ kind: 'paragraph', text: long }] }, flags: [],
    };
    const { brief } = renderReadingBrief([artifact]);
    expect(brief).toContain('קוצץ');
    expect(brief.length).toBeLessThan(long.length);
  });

  it('caps the total brief length and keeps the outline', () => {
    // Four text artefacts, each with BRIEF_TEXT_CHARS length, exceed the total cap significantly.
    // ~32,000 chars vs 24,000 cap ensures truncation actually happens.
    const marker1 = 'מזהה_ראשון_';
    const marker4 = 'מזהה_רביעי_';
    const longText = 'א'.repeat(BRIEF_TEXT_CHARS - marker1.length);

    const artifacts: DocumentArtifact[] = [
      OUTLINE,
      {
        ordinal: 1, kind: 'text', partName: 'חלק1',
        content: { blocks: [{ kind: 'paragraph', text: marker1 + longText }] },
        flags: [],
      },
      {
        ordinal: 2, kind: 'text', partName: 'חלק2',
        content: { blocks: [{ kind: 'paragraph', text: 'א'.repeat(BRIEF_TEXT_CHARS) }] },
        flags: [],
      },
      {
        ordinal: 3, kind: 'text', partName: 'חלק3',
        content: { blocks: [{ kind: 'paragraph', text: 'א'.repeat(BRIEF_TEXT_CHARS) }] },
        flags: [],
      },
      {
        ordinal: 4, kind: 'text', partName: 'חלק4',
        content: { blocks: [{ kind: 'paragraph', text: marker4 + 'א'.repeat(BRIEF_TEXT_CHARS - marker4.length) }] },
        flags: [],
      },
    ];

    const { brief } = renderReadingBrief(artifacts);

    // The outline must survive when total cap is hit.
    expect(brief).toContain('מחירון');
    expect(brief).toContain('has_macros');

    // First artefact's marker is present (early enough to be included).
    expect(brief).toContain(marker1);

    // Last artefact's marker is absent (dropped by the total cap).
    expect(brief).not.toContain(marker4);

    // Brief length is bounded, with small allowance for the truncation marker.
    expect(brief.length).toBeLessThanOrEqual(BRIEF_TOTAL_CHARS + 200);
  });

  it('reports which parts it kept, so a citation can be judged against the brief', () => {
    const artifacts: DocumentArtifact[] = [OUTLINE];
    for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
      artifacts.push({
        ordinal, kind: 'text', partName: `חלק${ordinal}`,
        content: { blocks: [{ kind: 'paragraph', text: 'א'.repeat(BRIEF_TEXT_CHARS) }] },
        flags: [],
      });
    }
    const { brief, includedOrdinals } = renderReadingBrief(artifacts);

    // Whatever the ceiling let through, the claim and the text must agree —
    // every reported ordinal is labelled in the brief, and every part the
    // brief does not label is absent from the claim.
    expect(includedOrdinals.length).toBeGreaterThan(0);
    expect(includedOrdinals.length).toBeLessThan(artifacts.length);
    for (const artifact of artifacts) {
      expect(brief.includes(`[חלק ${artifact.ordinal}]`)).toBe(
        includedOrdinals.includes(artifact.ordinal),
      );
    }
    expect(brief).toContain('קוצץ');
  });

  it('keeps a single oversized part rather than returning a brief about nothing', () => {
    // A lone section past the ceiling is cut and marked. Dropping it whole
    // would leave a question with no document attached to it.
    const huge: DocumentArtifact = {
      ordinal: 3, kind: 'table', partName: 'ענקית',
      content: { rows: [[s('פריט')], ...Array.from({ length: BRIEF_TABLE_ROWS }, () => [s('א'.repeat(1_000))])] },
      flags: [],
    };
    const { brief, includedOrdinals } = renderReadingBrief([huge]);
    expect(includedOrdinals).toEqual([3]);
    expect(brief).toContain('[חלק 3]');
    expect(brief).toContain('קוצץ');
    expect(brief.length).toBeLessThanOrEqual(BRIEF_TOTAL_CHARS + 200);
  });

  it('renders a stated gap when content shape does not match its declared kind', () => {
    // Table with no rows
    const missingRows: DocumentArtifact = {
      ordinal: 0, kind: 'table', partName: 'broken_table',
      content: {}, // missing rows
      flags: [],
    };
    const { brief: briefTable } = renderReadingBrief([missingRows]);
    expect(briefTable).toContain('(טבלה לא קריאה)');
    expect(() => renderReadingBrief([missingRows])).not.toThrow();

    // Text with no blocks
    const missingBlocks: DocumentArtifact = {
      ordinal: 0, kind: 'text', partName: 'broken_text',
      content: {}, // missing blocks
      flags: [],
    };
    const { brief: briefText } = renderReadingBrief([missingBlocks]);
    expect(briefText).toContain('(טקסט לא קריא)');
    expect(() => renderReadingBrief([missingBlocks])).not.toThrow();

    // Outline with no parts
    const missingParts: DocumentArtifact = {
      ordinal: 0, kind: 'outline', partName: null,
      content: {}, // missing parts
      flags: [],
    };
    const { brief: briefOutline } = renderReadingBrief([missingParts]);
    expect(briefOutline).toContain('(מתאר לא קריא)');
    expect(() => renderReadingBrief([missingParts])).not.toThrow();
  });

  it('is deterministic — the same artefacts render byte-identically', () => {
    expect(renderReadingBrief([OUTLINE, TEXT]).brief).toBe(renderReadingBrief([OUTLINE, TEXT]).brief);
    expect(renderReadingBrief([OUTLINE, TEXT])).toEqual(renderReadingBrief([OUTLINE, TEXT]));
  });

  it('produces a brief for an empty artefact list rather than an empty string', () => {
    // An empty document is a fact to state, not a prompt with nothing in it.
    expect(renderReadingBrief([]).brief.trim()).not.toBe('');
  });
});

/**
 * `conduct.ts`'s `beginVerification` (Task 11, fix round 2's item 1). The
 * regression: `JSON.stringify(artifact.content)` puts no space after a key's
 * colon, so a numeric cell (`{"v":11988,"t":"number"}`) sits immediately
 * after a `:` — exactly the shape `numeric-grounding.ts`'s `numbersIn` skips
 * on purpose (its date/time/range guard). On a spreadsheet or table artefact
 * this zeroed the ENTIRE grounded set, and because the source list was
 * non-empty, `ungroundedNumbers`'s own "an empty list grounds everything"
 * safety never fired — every number in the draft read as ungrounded. This is
 * the canonical `.xlsx`-quote shape (an amount in its own cell), so it is
 * pinned here directly, against `ungroundedNumbers` itself, not merely
 * against `renderArtifactFull`'s own output shape.
 */
describe('renderArtifactFull — the numeric-grounding regression', () => {
  const XLSX_LIKE: DocumentArtifact = {
    ordinal: 1,
    kind: 'table',
    partName: 'הצעת מחיר',
    content: { rows: [[s('פריט'), s('סכום')], [s('סה"כ'), n(11988)]] },
    flags: [],
  };

  it('grounds a number that sits in its own table cell', () => {
    const draft = 'הסכום לתשלום הוא 11,988 ש"ח.';
    expect(ungroundedNumbers(draft, [renderArtifactFull(XLSX_LIKE)])).toEqual([]);
  });

  it('is the fix for a real regression: JSON.stringify of the same content does NOT ground it', () => {
    const draft = 'הסכום לתשלום הוא 11,988 ש"ח.';
    // Not an assertion about `renderArtifactFull` — a demonstration that the
    // alternative this replaced was actually broken, on the exact content
    // the test above proves the fix for.
    expect(ungroundedNumbers(draft, [JSON.stringify(XLSX_LIKE.content)])).toEqual(['11988']);
  });

  it('renders a table the same way renderReadingBrief does, just without its row cap', () => {
    expect(renderArtifactFull(XLSX_LIKE)).toBe('פריט | סכום\n---\nסה"כ | 11988');
  });
});
