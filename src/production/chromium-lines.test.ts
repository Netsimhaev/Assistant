import { describe, expect, it } from 'vitest';
import { linesOf } from '../documents/extractors/pdf.js';
import { joinChromiumLine, MAX_CROSS_GAP_EM } from './chromium-lines.js';

/**
 * Lines as headless Chromium writes them (items copied from a real produced
 * PDF, `npm run doc:render-check`): every glyph run is its own item, in
 * VISUAL order, and pdf.js marks neutrals and numbers `ltr`. Before the
 * run grouping, a Latin word split into several items, a currency sign
 * beside its number and a mirrored parenthesis all came back reversed.
 */
describe('joinChromiumLine — split runs inside a line', () => {
  const item = (str: string, dir: 'ltr' | 'rtl', x: number, width: number, y = 690) => ({
    str,
    dir,
    transform: [10, 0, 0, 10, x, y],
    width,
    height: 10,
  });

  it('an RTL sentence keeps a split Latin word, a currency sign and the parentheses in logical order', () => {
    const items = [
      item('(', 'ltr', 155, 3),
      item('4.2', 'ltr', 159, 16),
      item('ראה סעיף', 'rtl', 177, 46),
      item(')', 'ltr', 223, 3),
      item('39%', 'ltr', 230, 22),
      item('אחרי הנחה של', 'rtl', 254, 68),
      item('₪', 'ltr', 326, 9),
      item('1,890', 'ltr', 334, 28),
      item('עולה', 'rtl', 365, 22),
      item('O', 'ltr', 391, 9),
      item('ffi', 'ltr', 399, 10),
      item('ce', 'ltr', 410, 11),
      item('Pro', 'ltr', 424, 18),
      item('מ מדגם', 'rtl', 445, 35),
      item('"', 'ltr', 480, 4),
      item('ס', 'rtl', 484, 7),
      item('160', 'ltr', 494, 19),
      item('שולחן', 'rtl', 516, 28),
    ];
    expect(linesOf(items, joinChromiumLine)).toEqual(['שולחן 160 ס"מ מדגם Office Pro עולה ₪1,890 אחרי הנחה של 39% (ראה סעיף 4.2)']);
  });

  it('a table row with more digits than Hebrew letters is still read right to left, cells apart', () => {
    const items = [
      item('מ', 'rtl', 466, 7, 637),
      item('"', 'ltr', 473, 4, 637),
      item('ס', 'rtl', 478, 7, 637),
      item('160', 'ltr', 488, 19, 637),
      item('שולחן', 'rtl', 510, 28, 637),
      item('₪', 'ltr', 261, 9, 637),
      item('1,890', 'ltr', 269, 28, 637),
      item('39%', 'ltr', 135, 22, 637),
    ];
    expect(linesOf(items, joinChromiumLine)).toEqual(['שולחן 160 ס"מ ₪1,890 39%']);
  });

  it('a Hebrew phrase split into items inside an English line reads right to left', () => {
    const items = [
      item('Supplier', 'ltr', 36, 40),
      item('עולם', 'rtl', 80, 24),
      item('לום', 'rtl', 108, 18),
      item('ש', 'rtl', 126, 6),
      item('(Ltd)', 'ltr', 140, 25),
    ];
    // Visual left-to-right: Supplier, עולם, לום|ש, (Ltd). The Hebrew run is
    // read right to left, so "שלום" (split into two touching items) comes first.
    expect(linesOf(items, joinChromiumLine)).toEqual(['Supplier שלום עולם (Ltd)']);
  });

  it('a number-only line keeps left-to-right order', () => {
    const items = [item('1', 'ltr', 289, 5, 17), item('/', 'ltr', 296, 3, 17), item('1', 'ltr', 301, 5, 17)];
    expect(linesOf(items, joinChromiumLine)).toEqual(['1 / 1']);
  });
});


describe('joinChromiumLine — never regroups table cells', () => {
  const cell = (str: string, dir: 'ltr' | 'rtl', x: number, width: number) => ({
    str,
    dir,
    transform: [10, 0, 0, 10, x, 500],
    width,
    height: 10,
  });

  it('cells ~6em apart keep positional order, in both directions (same rows as the inbound regression)', () => {
    expect(
      linesOf(
        [cell('Chair', 'ltr', 36, 25), cell('AB-100', 'ltr', 121, 32), cell('תיאור המוצר המלא', 'rtl', 213, 80)],
        joinChromiumLine,
      ),
    ).toEqual(['תיאור המוצר המלא AB-100 Chair']);
    expect(
      linesOf(
        [cell('Item', 'ltr', 36, 20), cell('Supplier', 'ltr', 116, 40), cell('שולחן', 'rtl', 216, 28), cell('כיסא', 'rtl', 304, 22)],
        joinChromiumLine,
      ),
    ).toEqual(['Item Supplier שולחן כיסא']);
  });

  it('joins two Latin words in a Hebrew line up to the bound, and not beyond it', () => {
    const line = (gapEm: number) => [
      cell('שולחן מעוצב חדש', 'rtl', 300, 80),
      cell('Pro', 'ltr', 300 - 4 - 18, 18),
      cell('Office', 'ltr', 300 - 4 - 18 - gapEm * 10 - 30, 30),
    ];
    expect(linesOf(line(MAX_CROSS_GAP_EM), joinChromiumLine)).toEqual(['שולחן מעוצב חדש Office Pro']);
    expect(linesOf(line(MAX_CROSS_GAP_EM + 0.2), joinChromiumLine)).toEqual(['שולחן מעוצב חדש Pro Office']);
  });
});
