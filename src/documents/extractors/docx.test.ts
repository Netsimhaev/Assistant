import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extractDocx, readTrackedChangeInfo } from './docx.js';
import {
  W_NS,
  XML_HEADER,
  documentXml,
  tempDocxPath,
  writeDocx,
} from '../fixtures/build-docx.js';
import type { Block, TableContent, TextContent } from '../types.js';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const blocksOf = (content: unknown): Block[] => (content as TextContent).blocks;
const rowsOf = (content: unknown): TableContent['rows'] => (content as TableContent).rows;

// `word/comments.xml` is found by mammoth's own path-fallback
// (`findPartPath`'s `fallbackPath: "word/comments.xml"`) with no
// relationship entry needed — verified directly against the library before
// this file's comment-only test below was written.

// Same numbering definition as `tiny.docx` (numId 1 -> a level-0 bullet) —
// verified against the fixture's own `word/numbering.xml` before writing
// this.
const BULLET_NUMBERING = `${XML_HEADER}
<w:numbering ${W_NS}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="bullet"/>
      <w:lvlText w:val="&#xF0B7;"/>
      <w:pPr/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

function bulletItemXml(text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

describe('extractDocx', () => {
  it('keeps a heading a heading', async () => {
    const [body] = await extractDocx(fixture('tiny.docx'));
    const blocks = blocksOf(body?.content);
    expect(blocks[0]).toEqual({ kind: 'heading', level: 1, text: 'הסכם התקשרות' });
  });

  it('keeps a table a table rather than smearing it into a line', async () => {
    const artifacts = await extractDocx(fixture('tiny.docx'));
    expect(artifacts.filter((a) => a.kind === 'table')).toHaveLength(1);
  });

  it('includes tracked changes and flags them', async () => {
    const artifacts = await extractDocx(fixture('tiny.docx'));
    expect(artifacts.some((a) => a.flags.includes('tracked_changes'))).toBe(true);
  });

  it('produces exactly the blocks tiny.docx contains, in document order — heading, then the bullet list as one block, then the paragraph carrying the inserted sentence inline', async () => {
    // A single strong assertion pinning down the whole `blocks` array, not
    // just its length or first element: this is what actually rules out a
    // smeared table, a dropped list, or a heading downgraded to a
    // paragraph. `w:ins`'s content (see the fixture's `word/document.xml`)
    // sits inline with no separating space in the source, so the two runs
    // concatenate directly — that space (or lack of it) mirrors the source
    // exactly, not an artefact of this test's expectations.
    const [body] = await extractDocx(fixture('tiny.docx'));
    const blocks = blocksOf(body?.content);
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'הסכם התקשרות' },
      { kind: 'list', items: ['סעיף ראשון בהסכם', 'סעיף שני בהסכם'] },
      {
        kind: 'paragraph',
        text: 'בין הצדדים נחתם הסכם זה בתנאים הרגילים.סעיף שהוסף בעדכון האחרון למען הסר ספק.',
      },
    ]);
  });

  it("shapes the table's non-empty text cells exactly like xlsx.ts's TableContent, with genuine string content typed 'string'", async () => {
    // tiny.docx's own table is all plain text ("עמודה א" over "ערך 1", …) —
    // this only proves the shape survives for a genuinely string-typed cell.
    // It does not prove a numeric-looking or empty cell classifies the way
    // xlsx.ts's does; the test below does, using a hand-built table this
    // fixture cannot express.
    const artifacts = await extractDocx(fixture('tiny.docx'));
    const table = artifacts.find((a) => a.kind === 'table');
    expect(rowsOf(table?.content)).toEqual([
      [
        { v: 'עמודה א', t: 'string' },
        { v: 'עמודה ב', t: 'string' },
      ],
      [
        { v: 'ערך 1', t: 'string' },
        { v: 'ערך 2', t: 'string' },
      ],
    ]);
  });

  it('classifies a numeric-looking cell as number and an empty cell as empty, not unconditionally string — the fix for I3: a Word table must be interchangeable with an xlsx/csv table', async () => {
    // Before this fix, expandTableRows built every cell as
    // `{ v: text.trim(), t: 'string' }` unconditionally, which meant no
    // Word table could ever produce a numeric range or headers in
    // outline.ts (detectHeaders/columnStats need a non-string cell
    // somewhere). Cells now classify through the same ../cell.ts
    // `classifyField` csv.ts uses.
    const path = await writeDocx('typed-cells.docx', {
      'word/document.xml': documentXml(
        '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>' +
          '<w:tr><w:tc><w:p><w:r><w:t>פריט</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>מחיר</w:t></w:r></w:p></w:tc></w:tr>' +
          '<w:tr><w:tc><w:p><w:r><w:t>עט</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>10</w:t></w:r></w:p></w:tc></w:tr>' +
          '<w:tr><w:tc><w:p/></w:tc><w:tc><w:p><w:r><w:t>20</w:t></w:r></w:p></w:tc></w:tr>' +
          '</w:tbl>',
      ),
    });

    const artifacts = await extractDocx(path);
    const table = artifacts.find((a) => a.kind === 'table');
    expect(rowsOf(table?.content)).toEqual([
      [
        { v: 'פריט', t: 'string' },
        { v: 'מחיר', t: 'string' },
      ],
      [
        { v: 'עט', t: 'string' },
        { v: 10, t: 'number' },
      ],
      [
        { v: null, t: 'empty' },
        { v: 20, t: 'number' },
      ],
    ]);
  });

  it('puts the tracked_changes flag on the first (text) artefact, the document-level slot has_macros already uses in xlsx.ts', async () => {
    const artifacts = await extractDocx(fixture('tiny.docx'));
    expect(artifacts[0]?.kind).toBe('text');
    expect(artifacts[0]?.flags).toContain('tracked_changes');
    expect(artifacts.slice(1).every((a) => !a.flags.includes('tracked_changes'))).toBe(true);
  });

  it('orders the text artefact first (ordinal 0) and each table after it, in document order', async () => {
    const artifacts = await extractDocx(fixture('tiny.docx'));
    expect(artifacts.map((a) => [a.ordinal, a.kind])).toEqual([
      [0, 'text'],
      [1, 'table'],
    ]);
  });

  it('keeps the deleted text of a tracked-change deletion in the output, not only the surviving and inserted text', async () => {
    const path = await writeDocx(
      'deletion.docx',
      {
        'word/document.xml': documentXml(
          '<w:p>' +
            '<w:r><w:t>טקסט שנשאר. </w:t></w:r>' +
            '<w:del w:id="1" w:author="עורך" w:date="2026-08-25T00:00:00Z">' +
            '<w:r><w:delText>טקסט שנמחק בעדכון.</w:delText></w:r>' +
            '</w:del>' +
            '</w:p>',
        ),
      },
    );

    const [body] = await extractDocx(path);
    const blocks = blocksOf(body?.content);

    // The surviving run is its own ordinary paragraph — mammoth drops the
    // deleted run entirely from the tree, exactly as verified against the
    // library directly before writing this extractor.
    expect(blocks[0]).toEqual({ kind: 'paragraph', text: 'טקסט שנשאר.' });

    // The deleted text is not silently gone: it is present, somewhere in
    // the text artefact's blocks, recovered from `word/document.xml`'s raw
    // `w:delText` runs.
    const allText = blocks.map((b) => (b.kind === 'list' ? b.items.join(' ') : b.text)).join(' ');
    expect(allText).toContain('טקסט שנמחק בעדכון.');

    expect(body?.flags).toContain('tracked_changes');
  });

  it('flags tracked_changes for a comment alone, with no w:ins or w:del in the body', async () => {
    const path = await writeDocx('comment-only.docx', {
      'word/document.xml': documentXml(
        '<w:p><w:r><w:t>טקסט רגיל בלי מעקב שינויים.</w:t></w:r></w:p>',
      ),
      'word/comments.xml': `${XML_HEADER}
<w:comments ${W_NS}>
  <w:comment w:id="1" w:author="בודק/ת"><w:p><w:r><w:t>הערה לבדיקה</w:t></w:r></w:p></w:comment>
</w:comments>`,
    });

    const [body] = await extractDocx(path);
    expect(body?.flags).toContain('tracked_changes');
    expect(blocksOf(body?.content)).toEqual([
      { kind: 'paragraph', text: 'טקסט רגיל בלי מעקב שינויים.' },
    ]);
  });

  it('does not flag tracked_changes when there is no insertion, deletion, or comment', async () => {
    const path = await writeDocx('plain.docx', {
      'word/document.xml': documentXml('<w:p><w:r><w:t>מסמך רגיל.</w:t></w:r></w:p>'),
    });

    const [body] = await extractDocx(path);
    expect(body?.flags).not.toContain('tracked_changes');
  });

  it('closes one list and opens a new one when a real paragraph interrupts a run of list items, rather than merging them into one block', async () => {
    const path = await writeDocx('interrupted-list.docx', {
      'word/document.xml': documentXml(
        bulletItemXml('פריט א') +
          bulletItemXml('פריט ב') +
          '<w:p><w:r><w:t>פסקה שמפרידה בין הרשימות.</w:t></w:r></w:p>' +
          bulletItemXml('פריט ג'),
      ),
      'word/numbering.xml': BULLET_NUMBERING,
    });

    const [body] = await extractDocx(path);
    expect(blocksOf(body?.content)).toEqual([
      { kind: 'list', items: ['פריט א', 'פריט ב'] },
      { kind: 'paragraph', text: 'פסקה שמפרידה בין הרשימות.' },
      { kind: 'list', items: ['פריט ג'] },
    ]);
  });

  it('does not crash on a table nested inside another table’s cell, and keeps the inner cells’ text readable rather than dropping them', async () => {
    const innerTable =
      '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid>' +
      '<w:tr><w:tc><w:p><w:r><w:t>פנימי</w:t></w:r></w:p></w:tc></w:tr>' +
      '</w:tbl>';
    const path = await writeDocx('nested-table.docx', {
      'word/document.xml': documentXml(
        '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid>' +
          `<w:tr><w:tc><w:p><w:r><w:t>לפני</w:t></w:r></w:p>${innerTable}</w:tc></w:tr>` +
          '</w:tbl>',
      ),
    });

    const artifacts = await extractDocx(path);
    const table = artifacts.find((a) => a.kind === 'table');
    const rows = rowsOf(table?.content);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(1);
    // The nested table's own cell text is flattened into the outer cell
    // rather than lost — "sane, not crash" per this task's self-review
    // bar, not a claim that the inner table is extracted as its own
    // artefact (it deliberately is not; see the module docblock).
    expect(rows[0]?.[0]?.v).toContain('פנימי');
    expect(artifacts.filter((a) => a.kind === 'table')).toHaveLength(1);
  });

  it('produces only the text artefact, with an empty blocks array, for a document with a body but no content at all', async () => {
    const path = await writeDocx('empty.docx', { 'word/document.xml': documentXml('') });

    const artifacts = await extractDocx(path);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual({ ordinal: 0, kind: 'text', partName: null, content: { blocks: [] }, flags: [] });
  });

  it('does not split a list across a blank paragraph between two bullet points — the blank line Word leaves behind mid-edit must not read as a real break', async () => {
    const path = await writeDocx('blank-paragraph-in-list.docx', {
      'word/document.xml': documentXml(bulletItemXml('פריט א') + '<w:p/>' + bulletItemXml('פריט ב')),
      'word/numbering.xml': BULLET_NUMBERING,
    });

    const [body] = await extractDocx(path);
    expect(blocksOf(body?.content)).toEqual([{ kind: 'list', items: ['פריט א', 'פריט ב'] }]);
  });

  it('expands a horizontal merge (w:gridSpan): the merged cell fills every column it visually covers', async () => {
    const path = await writeDocx('horizontal-merge.docx', {
      'word/document.xml': documentXml(
        '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>' +
          '<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>ממוזג רוחבית</w:t></w:r></w:p></w:tc></w:tr>' +
          '<w:tr><w:tc><w:p><w:r><w:t>שורה2 עמודה1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>שורה2 עמודה2</w:t></w:r></w:p></w:tc></w:tr>' +
          '</w:tbl>',
      ),
    });

    const artifacts = await extractDocx(path);
    const table = artifacts.find((a) => a.kind === 'table');
    expect(rowsOf(table?.content)).toEqual([
      [
        { v: 'ממוזג רוחבית', t: 'string' },
        { v: 'ממוזג רוחבית', t: 'string' },
      ],
      [
        { v: 'שורה2 עמודה1', t: 'string' },
        { v: 'שורה2 עמודה2', t: 'string' },
      ],
    ]);
  });

  it('expands a vertical merge (w:vMerge) without shifting the surviving cell into the wrong column — this is the exact bug the ruling named', async () => {
    const path = await writeDocx('vertical-merge.docx', {
      'word/document.xml': documentXml(
        '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>' +
          '<w:tr>' +
          '<w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>ממוזג אנכית</w:t></w:r></w:p></w:tc>' +
          '<w:tc><w:p><w:r><w:t>שורה1 עמודה2</w:t></w:r></w:p></w:tc>' +
          '</w:tr>' +
          '<w:tr>' +
          '<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>' +
          '<w:tc><w:p><w:r><w:t>שורה2 עמודה2</w:t></w:r></w:p></w:tc>' +
          '</w:tr>' +
          '</w:tbl>',
      ),
    });

    const artifacts = await extractDocx(path);
    const table = artifacts.find((a) => a.kind === 'table');
    const rows = rowsOf(table?.content);

    // mammoth filters the second row's vMerge-continuation cell out of
    // row.children entirely, leaving only one real cell there
    // ("שורה2 עמודה2") — a naive index-0 placement of that surviving cell
    // is exactly the shift the ruling reported (a reviewer's repro showed
    // column 2's value landing at index 0). The correct row 2 is
    // [column0: the merged value carried down, column1: its own cell] —
    // not [column0: "שורה2 עמודה2"].
    expect(rows).toEqual([
      [
        { v: 'ממוזג אנכית', t: 'string' },
        { v: 'שורה1 עמודה2', t: 'string' },
      ],
      [
        { v: 'ממוזג אנכית', t: 'string' },
        { v: 'שורה2 עמודה2', t: 'string' },
      ],
    ]);
  });

  it('flags tracked_changes when the raw-XML scan cannot find word/document.xml at its expected name — fails closed, not open', async () => {
    // A legal (if unusual) OOXML package: the main document part lives at
    // a non-default path, reachable only via the relationship
    // `_rels/.rels` declares. mammoth follows the relationship and reads
    // it fine — verified directly against the library before writing this
    // test — but this module's raw-XML fallback only ever looks for the
    // literal name "word/document.xml", which this package does not have.
    const rels = `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/main.xml"/>
</Relationships>`;
    const path = await writeDocx('redirected-main-part.docx', {
      '_rels/.rels': rels,
      'word/main.xml': documentXml('<w:p><w:r><w:t>מסמך בנתיב לא רגיל</w:t></w:r></w:p>'),
    });

    const [body] = await extractDocx(path);
    // The document itself was read correctly (proof mammoth succeeded)...
    expect(blocksOf(body?.content)).toEqual([{ kind: 'paragraph', text: 'מסמך בנתיב לא רגיל' }]);
    // ...but the scan that should have looked for tracked changes could
    // not complete, and a scan that could not complete must flag rather
    // than silently report "none found".
    expect(body?.flags).toContain('tracked_changes');
  });

  it('readTrackedChangeInfo reports it could not scan — not "no tracked changes" — for bytes that are not a ZIP at all', async () => {
    const path = await tempDocxPath('not-a-zip.docx');
    await writeFile(path, 'this is not a zip file, just plain bytes, no PK signature anywhere');

    await expect(readTrackedChangeInfo(path)).resolves.toEqual({ scanned: false });
  });

  it('readTrackedChangeInfo reports it could not scan when word/document.xml is simply absent from an otherwise well-formed ZIP', async () => {
    const path = await writeDocx('scan-missing-entry.docx', {
      'word/other.xml': documentXml('<w:p><w:r><w:t>לא במקום הרגיל</w:t></w:r></w:p>'),
    });

    await expect(readTrackedChangeInfo(path)).resolves.toEqual({ scanned: false });
  });

  it('readTrackedChangeInfo reports it could not scan when word/document.xml is stored deflated (method 8) with a corrupt stream — readEntryData\'s inflateRawSync catch branch, never reached by buildDocx\'s store-only (method 0) entries', async () => {
    // buildDocx (../fixtures/build-docx.ts) only ever writes method-0
    // (store) entries — its own docblock says so — so every other test in
    // this file that hits `readZipEntry` returns before `readEntryData`'s
    // `method === 8` branch runs at all. Hand-build a one-entry ZIP with
    // that entry marked deflate whose "compressed" bytes are not valid
    // deflate data, so `inflateRawSync` throws and the branch's own
    // `catch { return null }` is what actually turns this into
    // `scanned: false` — not the "entry not found" path the tests above
    // already cover.
    const nameBuf = Buffer.from('word/document.xml', 'utf8');
    const corrupt = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x00]);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8); // method: deflate
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14); // crc: never checked by this module's reader
    localHeader.writeUInt32LE(corrupt.length, 18);
    localHeader.writeUInt32LE(corrupt.length, 22); // uncompressedSize: not read by readEntryData either
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    const localEntry = Buffer.concat([localHeader, nameBuf, corrupt]);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10); // method: deflate
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(corrupt.length, 20);
    centralHeader.writeUInt32LE(corrupt.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(0, 42); // localHeaderOffset
    const centralEntry = Buffer.concat([centralHeader, nameBuf]);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(centralEntry.length, 12);
    eocd.writeUInt32LE(localEntry.length, 16);
    eocd.writeUInt16LE(0, 20);

    const path = await tempDocxPath('corrupt-deflate.docx');
    await writeFile(path, Buffer.concat([localEntry, centralEntry, eocd]));

    await expect(readTrackedChangeInfo(path)).resolves.toEqual({ scanned: false });
  });

  // I4: §5.3's content caps, moved into ../cell.ts and applied here the same
  // way xlsx.test.ts already proves them for sheets.
  it('caps table rows at 50,000 and flags the table artefact truncated, dropping what came after the cap', async () => {
    const totalRows = 50_001;
    const rowsXml = Array.from({ length: totalRows }, (_, i) => {
      const label = i === 49_999 ? 'last-in-cap' : i === 50_000 ? 'beyond-cap' : `r${i}`;
      return `<w:tr><w:tc><w:p><w:r><w:t>${label}</w:t></w:r></w:p></w:tc></w:tr>`;
    }).join('');
    const path = await writeDocx('row-cap.docx', {
      'word/document.xml': documentXml(
        `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid>${rowsXml}</w:tbl>`,
      ),
    });

    const artifacts = await extractDocx(path);
    const table = artifacts.find((a) => a.kind === 'table');
    const rows = rowsOf(table?.content);

    expect(rows).toHaveLength(50_000);
    expect(rows[49_999]?.[0]).toEqual({ v: 'last-in-cap', t: 'string' });
    expect(rows.some((row) => row.some((cell) => cell.v === 'beyond-cap'))).toBe(false);
    expect(table?.flags).toContain('truncated');
  }, 30_000);

  it('caps a table cell at 32,768 characters and flags the table artefact truncated', async () => {
    const longText = 'א'.repeat(40_000);
    const path = await writeDocx('table-cell-cap.docx', {
      'word/document.xml': documentXml(
        '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid>' +
          `<w:tr><w:tc><w:p><w:r><w:t>${longText}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
      ),
    });

    const artifacts = await extractDocx(path);
    const table = artifacts.find((a) => a.kind === 'table');
    const rows = rowsOf(table?.content);
    const cell = rows[0]?.[0];

    expect(cell?.t).toBe('string');
    expect((cell?.v as string).length).toBe(32_768);
    expect(table?.flags).toContain('truncated');
  });

  it("caps a paragraph block's text at 32,768 characters and flags the text artefact truncated — the document-level slot tracked_changes already uses", async () => {
    const longText = 'ב'.repeat(40_000);
    const path = await writeDocx('block-text-cap.docx', {
      'word/document.xml': documentXml(`<w:p><w:r><w:t>${longText}</w:t></w:r></w:p>`),
    });

    const [body] = await extractDocx(path);
    const blocks = blocksOf(body?.content);
    const paragraph = blocks.find((b) => b.kind === 'paragraph');

    expect(paragraph?.kind).toBe('paragraph');
    if (paragraph?.kind === 'paragraph') {
      expect(paragraph.text.length).toBe(32_768);
    }
    expect(body?.flags).toContain('truncated');
  });
});
