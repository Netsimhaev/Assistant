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
    // The cell separator itself, pinned — fix round 3, item 2: with
    // `renderTable` now shared between this (capped) path and
    // `renderArtifactFull`'s (uncapped) path, a change to the separator must
    // fail a test on BOTH sides, not silently pass here while only the other
    // side's test notices.
    expect(brief).toContain('פריט | מחיר');
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

  /**
   * Fix round 3, item 2: a hard-coded literal here proved nothing about
   * equality with `renderReadingBrief`'s own output — changing the shared
   * separator only in the capped path would have left this test green while
   * the two renderers silently diverged. Derived from `renderReadingBrief`'s
   * ACTUAL output instead: `XLSX_LIKE` has one data row, far under
   * `BRIEF_TABLE_ROWS`, so capping never engages and the body is byte-
   * identical either way — what differs is only the section header
   * `renderReadingBrief` prepends, stripped here by its own known format.
   */
  it('renders a table exactly as renderReadingBrief renders the same content', () => {
    const { brief } = renderReadingBrief([XLSX_LIKE]);
    const header = `[חלק ${XLSX_LIKE.ordinal}] ${XLSX_LIKE.partName ?? '(ללא שם)'} — ${XLSX_LIKE.kind}`;
    expect(brief.startsWith(`${header}\n`)).toBe(true);
    expect(brief.slice(header.length + 1)).toBe(renderArtifactFull(XLSX_LIKE));
  });

  /**
   * Fix round 3, item 3: `renderTable`'s capped path never reached a row past
   * `BRIEF_TABLE_ROWS`, so a malformed row further down never had a chance to
   * throw. Removing the cap on `renderArtifactFull`'s path means it now maps
   * every row — unless guarded. A malformed row is skipped, not fatal to the
   * rest of the table.
   */
  it('skips a malformed row rather than throwing, on the uncapped path', () => {
    const malformed: DocumentArtifact = {
      ordinal: 1,
      kind: 'table',
      partName: 'טבלה עם שורה פגומה',
      content: { rows: [[s('פריט'), s('סכום')], [s('תקין'), n(1)], null, [s('גם תקין'), n(2)]] as unknown as Cell[][] },
      flags: [],
    };
    expect(() => renderArtifactFull(malformed)).not.toThrow();
    expect(renderArtifactFull(malformed)).toBe('פריט | סכום\n---\nתקין | 1\nגם תקין | 2');
  });

  /**
   * Fix round 4, item 2 — the same class of bug as item 3, one level down.
   * A row that IS an array but holds a malformed CELL is unguarded by
   * `renderTable`'s own row check: `cellText` dereferences `cell.v` directly.
   * A 100-row table whose row 60 is `[null, {v:60}]` throws on the uncapped
   * path only, because the capped path never maps past row 40 to reach it.
   */
  it('skips a malformed cell rather than throwing, on the uncapped path', () => {
    const rows: Cell[][] = [[s('פריט'), s('סכום')]];
    for (let i = 0; i < 100; i += 1) rows.push([s(`שורה ${i}`), n(i)]);
    // Data row 60 (`rows[61]`, well past `BRIEF_TABLE_ROWS` = 40) has its
    // first CELL replaced with `null` — the row is still a real array, so
    // `renderTable`'s row guard does not catch this; only `cellText`'s own
    // guard does.
    (rows[61] as unknown as (Cell | null)[])[0] = null;
    const artifact: DocumentArtifact = {
      ordinal: 1,
      kind: 'table',
      partName: 'טבלה עם תא פגום',
      content: { rows },
      flags: [],
    };

    expect(() => renderArtifactFull(artifact)).not.toThrow();
    const text = renderArtifactFull(artifact);
    // The malformed cell renders as empty, not fatal — the amount beside it
    // still renders, and the untouched rows around it are unaffected.
    expect(text).toContain(' | 60');
    expect(text).toContain('שורה 59 | 59');
    expect(text).toContain('שורה 61 | 61');
  });

  /**
   * A CSV-shaped document is stored as a `table` artefact too (one row per
   * line, no header semantics beyond "row zero"), and a plain-text artefact
   * grounds through the same `renderArtifact` path with no table layout at
   * all. Both exercised here so the fix is shown to hold across every shape
   * this renderer serves, not only the `.xlsx` case.
   */
  it('grounds a number from a CSV-shaped table row', () => {
    const csvLike: DocumentArtifact = {
      ordinal: 1,
      kind: 'table',
      partName: 'ייצוא CSV',
      content: { rows: [[s('תאריך'), s('סכום')], [s('2026-01-01'), n(7500)]] },
      flags: [],
    };
    expect(ungroundedNumbers('שולם 7,500 ש"ח', [renderArtifactFull(csvLike)])).toEqual([]);
  });

  it('grounds a number from a plain text artefact', () => {
    const textLike: DocumentArtifact = {
      ordinal: 1,
      kind: 'text',
      partName: 'סעיף תשלום',
      content: { blocks: [{ kind: 'paragraph', text: 'התמורה הכוללת היא 3,200 ש"ח.' }] },
      flags: [],
    };
    expect(ungroundedNumbers('התמורה 3,200 ש"ח', [renderArtifactFull(textLike)])).toEqual([]);
  });

  it('grounds a number from an outline artefact', () => {
    const outlineLike: DocumentArtifact = {
      ordinal: 0,
      kind: 'outline',
      partName: null,
      content: { parts: [{ name: 'עמוד 1', kind: 'text', rowCount: 640 }], flags: [] },
      flags: [],
    };
    expect(ungroundedNumbers('640 שורות בסך הכל', [renderArtifactFull(outlineLike)])).toEqual([]);
  });
});
